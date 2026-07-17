import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CancelSchedulerAdmissionResponseSchema,
  CapabilityUsageResponseSchema,
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyResponseSchema,
  ListHumanAttentionResponseSchema,
  ListSchedulerAdmissionsResponseSchema,
  ListServerAuditEventsResponseSchema,
  ListServerPermissionDecisionsResponseSchema,
  ListServerVaultUseRecordsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspaceInjectionPlansResponseSchema,
  ListWorkspaceInjectionReceiptsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceVaultGrantsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  RestartRuntimeConfigStaleSessionResponseSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
  StartChatModeResponseSchema,
  StartTaskModeResponseSchema,
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  ThreadGoalSummaryResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  parseWorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import {
  MetaResponseSchema,
  PROTOCOL_VERSION,
  SseEventEnvelopeSchema,
  ThreadSchema,
} from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';

import { type CreateAppOptions, createApp as createNanoCoreApp } from './app.js';
import {
  listWorkspaceAuditEvents,
  recordServerAuditEvent,
  recordWorkspaceAuditEvent,
} from './audit-events.js';
import { ensureLocalUser } from './auth/identity.js';
import {
  computeBootReadinessSnapshot,
  createShutdownReadinessSnapshot,
} from './bootstrap/readiness.js';
import {
  finishCapabilityCall,
  listWorkspaceCapabilityCalls,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { createInjectionPlan, listInjectionPlans } from './injection-plans.js';
import { createInjectionReceipt, listInjectionReceipts } from './injection-receipts.js';
import { StructuredWorkerDelegationRequestSchema } from './internal-agents/delegation.js';
import { createWorkerCoordinatorDecision } from './internal-agents/worker-coordinator.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { createDemoWorkspaceForUser, FsStore, type FsStoreOptions } from './lib/store.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { recordProductPermissionDecision } from './policy/permission-decisions.js';
import { ProviderRegistry } from './providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from './runtime/filesystem-workspace-sync.js';
import { listGitPushRecords, recordGitPushRecord } from './runtime/git-push-records.js';
import { GoalPlanOutputSchema } from './runtime/goal-plan.js';
import {
  createGoalReviewRecord,
  getGoalReviewRecord,
  listGoalReviewRecordsForTask,
  resolveGoalReviewRecord,
} from './runtime/goal-review-records.js';
import {
  createGoalPlanRecord,
  createGoalRecord,
  createGoalTask,
  getGoalRecord,
  listGoalRecordsForThread,
  listGoalTasks,
  updateGoalStatus,
  updateGoalTask,
} from './runtime/goal-store.js';
import {
  createGoalVerificationRecord,
  listGoalVerificationRecordsForTask,
} from './runtime/goal-verification-records.js';
import type {
  AgentSessionReadModel,
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './runtime/types.js';
import {
  getWorkerCheckpoint,
  listExportableWorkerCheckpoints,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './runtime/worker-checkpoints.js';
import { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { listWorkspaceApplyPlans } from './runtime/workspace-apply-plans.js';
import {
  listWorkspaceApplyResults,
  recordWorkspaceApplyResult,
} from './runtime/workspace-apply-results.js';
import { recordFilesystemWorkspaceStagingRoot } from './runtime/workspace-filesystem-staging.js';
import { recordWorkspaceQuarantineRecord } from './runtime/workspace-quarantine-records.js';
import { recordWorkspaceReconciliationRecord } from './runtime/workspace-reconciliation-records.js';
import {
  getWorkspaceSyncReview,
  listBackendWorkspaceHandles,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
  recordWorkspaceSyncReview,
  updateWorkspaceSyncReviewDecision,
} from './runtime/workspace-sync-records.js';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
  denySchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerSessionLease,
} from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import {
  LOCAL_USER_ID,
  readDataRootLayoutMarker,
  recordDataRootDeploymentMove,
} from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp as createDeterministicTestApp } from './test-support/app.js';
import { recordTestWorkspaceReviewMaterialization } from './test-support/workspace-sync.js';
import { createVaultGrant, listVaultGrants } from './vault/vault-grants.js';
import {
  createVaultReference,
  getVaultReference,
  listVaultReferences,
} from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { createVaultUseRecord, listVaultUseRecords } from './vault/vault-use-records.js';
import {
  listWorkspaceRepositoryResources,
  upsertWorkspaceRepositoryResource,
} from './workspace/repository-store.js';

const GOAL_TASK_RECORD_FIXTURE = {
  resources: [],
  expectedArtifacts: [],
  verificationChecks: [{ kind: 'manual' as const, description: 'Verify the task outcome.' }],
  reviewPolicy: {
    required: true,
    reviewers: ['human' as const],
    instructions: 'Review the completed task.',
  },
  escalationConditions: [],
};

/**
 * Opens a migrated Core database for turn-start repository tests.
 *
 * @returns Migrated Core database handles backed by a temporary data root.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-turn-repository-db-'));
  const coreDb = openCoreDb(dataRoot);

  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Opens a migrated workspace database for server route tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @param workspaceId Workspace id to open.
 * @returns Migrated workspace database handle.
 */
function openTestWorkspaceDb(coreDb: CoreDb, workspaceId: string): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, workspaceId);
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Records the exact scheduler lease lineage used by interrupted-worker retry route tests.
 *
 * @param coreDb Open Core database handle.
 * @param input Turn and lease state to record.
 */
function recordWorkerRetryLease(
  coreDb: CoreDb,
  input: {
    readonly agentSessionId: string;
    readonly recoveryState: 'awaiting-reconnect' | null;
    readonly releaseReason: string | null;
    readonly status: 'active' | 'released';
    readonly threadId: string;
    readonly turnId: string;
  }
): void {
  createSchedulerAdmissionEntry(coreDb, {
    priorityClass: 'interactive',
    profileRef: 'agent_codex_host',
    queueEntryId: `queue_${input.turnId}`,
    requestId: `request_${input.turnId}`,
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: input.threadId,
    turnId: input.turnId,
    turnInput: 'Run interrupted-worker retry fixture.',
    workspaceId: 'ws_demo',
  });
  createSchedulerPlacementPlan(coreDb, {
    degradedOptionalFeatures: [],
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    planId: `plan_${input.turnId}`,
    plannedLeaseDurationMs: 900_000,
    policyDecisionIds: [],
    queueEntryId: `queue_${input.turnId}`,
    schedulerEpoch: 1,
    selectedPoolId: 'pool_local',
    selectedTargetId: 'target_local',
  });
  createSchedulerSessionLease(coreDb, {
    agentSessionId: input.agentSessionId,
    expiresAt: '2099-01-01T01:00:00.000Z',
    heartbeatDeadline: '2099-01-01T00:10:00.000Z',
    leaseId: `lease_${input.turnId}`,
    packageSnapshotId: `aepsnap_${input.turnId}`,
    planId: `plan_${input.turnId}`,
    sandboxTokenBindingRef: `lease-binding:lease_${input.turnId}`,
    startupDeadline: '2099-01-01T00:05:00.000Z',
  });
  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
       SET status = ?, release_reason = ?, recovery_state = ?, recovery_deadline = ?
       WHERE lease_id = ?`
    )
    .run(
      input.status,
      input.releaseReason,
      input.recoveryState,
      input.recoveryState === 'awaiting-reconnect' ? '2099-01-01T00:05:00.000Z' : null,
      `lease_${input.turnId}`
    );
}

/**
 * Imports the Demo Workspace fixture into a test store when it is absent.
 *
 * @param store Store that should own the fixture.
 * @param userId User id namespace for fixture ids.
 */
function seedDemoWorkspace(store: FsStore, userId = LOCAL_USER_ID): void {
  const demo = createDemoWorkspaceForUser(userId);

  try {
    store.getWorkspace(demo.workspace.id);
    return;
  } catch {
    store.importWorkspaceSnapshot({
      workspace: demo.workspace,
      threads: [demo.thread],
      knowledge: demo.knowledge,
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
    });
  }
}

/**
 * Creates a test store with the legacy Demo Workspace fixture.
 *
 * @param options Store options.
 * @returns Store with Quick Chat plus Demo Workspace.
 */
function createDemoStore(options: FsStoreOptions = {}): FsStore {
  const store = new FsStore(options);
  seedDemoWorkspace(store, options.userId ?? LOCAL_USER_ID);
  return store;
}

/**
 * Creates a test app with the legacy Demo Workspace fixture.
 *
 * @param options App options.
 * @returns Test app.
 */
function createApp(options: CreateAppOptions = {}): ReturnType<typeof createNanoCoreApp> {
  if (options.coreDb) {
    ensureLocalUser(options.coreDb);
  }

  const store = options.store ?? createDemoStore();

  seedDemoWorkspace(store);
  return createDeterministicTestApp({ ...options, store });
}

/**
 * Returns the server-managed export root for one workspace export response.
 *
 * @param dataRoot Data root that owns server-managed exports.
 * @param workspaceId Workspace id used in the public export handle.
 * @param exportId Export id returned by the App API.
 * @returns Absolute export root path.
 */
function workspaceExportRoot(dataRoot: string, workspaceId: string, exportId: string): string {
  return join(dataRoot, 'server', 'exports', 'workspaces', workspaceId, exportId);
}

/**
 * Reads one exported JSON record file.
 *
 * @param root Workspace export root.
 * @param path Export-relative record path.
 * @returns Parsed JSON record.
 */
function readExportJson(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

/**
 * Reads one exported line-oriented JSON record family.
 *
 * @param root Workspace export root.
 * @param path Export-relative record path.
 * @returns Parsed JSONL records.
 */
function readExportJsonl(root: string, path: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(root, path), 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

/**
 * Creates an OpenShell package fixture bound to one stored turn.
 *
 * @param store Store that owns the workspace and turn.
 * @param turnId Turn id to bind to the package.
 * @returns Parsed Agent Environment Package.
 */
function createOpenShellWorkerControlPackage(
  store: FsStore,
  turnId: string
): AgentEnvironmentPackage {
  const turn = store.getTurnById(turnId);
  const agent = store.getAgent(turn.workspaceId, 'agent_codex_host');

  return AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'as_dashboard_control_1',
      userId: 'user_local',
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: 'req_dashboard_control_1',
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    })
  );
}

class FakeTurnExecutor implements TurnExecutor {
  public readonly capabilities = {
    approvals: false,
    interrupts: true,
    artifacts: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
    questions: false,
  };
  public readonly eventFamilies = [
    'workspace.updated',
    'thread.created',
    'thread.updated',
    'turn.started',
    'turn.updated',
    'item.created',
    'item.delta',
    'item.completed',
    'agent.session.updated',
    'turn.completed',
    'error',
  ] as const;
  public readonly startContexts: TurnStartRuntimeContext[] = [];

  /**
   * Emits a deterministic completed turn for route-level tests.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.startContexts.push(context);

    const turn = store.getTurnById(turnId);
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const requestId = context.requestId ?? null;
    const agentSession = store.createAgentSession({
      id: context.agentSessionId ?? `session_${turn.threadId}`,
      agentId: 'agent_codex_host',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      status: 'busy',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.updateTurn(turnId, { agentSessionId: agentSession.id });
    const userItem = store.createItem({
      id: `it_user_${turnId}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      type: 'user-message',
      status: 'completed',
      text: input,
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const assistantItem = store.createItem({
      id: `it_assistant_${turnId}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      type: 'assistant-message',
      status: 'completed',
      text: 'Completed by fake executor.',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    const completedTurn = store.updateTurn(turnId, {
      status: 'completed',
      completedAt: assistantItem.completedAt,
    });
    store.updateAgentSession(agentSession.id, {
      status: 'idle',
      updatedAt: assistantItem.completedAt ?? timestamp,
    });

    store.emitTurnEvent(turnId, {
      event: 'turn.started',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-started', turnId, status: 'running' },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.created',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-created', item: userItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.completed',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-completed', itemId: userItem.id, item: userItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'agent.session.updated',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'agent-session-updated', agentSession },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.created',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-created', item: assistantItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'item.completed',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'item-completed', itemId: assistantItem.id, item: assistantItem },
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.completed',
      requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
    });
  }

  /**
   * Marks a turn interrupted for route-level tests.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    const turn = store.updateTurn(turnId, {
      status: 'interrupted',
      completedAt: new Date().toISOString(),
    });
    store.emitTurnEvent(turnId, {
      event: 'turn.completed',
      requestId: context.requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-completed', stopReason: 'aborted', turn },
    });
  }
}

class OpenShellDashboardTurnExecutor extends FakeTurnExecutor {
  private readonly activeSession: AgentSessionReadModel;

  public constructor(activeSession: AgentSessionReadModel) {
    super();
    this.activeSession = activeSession;
  }

  /**
   * Returns the OpenShell session fixture for dashboard projection tests.
   *
   * @returns Active OpenShell session read model fixture.
   */
  public getAgentSession(): AgentSessionReadModel {
    return this.activeSession;
  }
}

class DelayedTurnExecutor extends FakeTurnExecutor {
  public starts = 0;
  private releaseStart: (() => void) | null = null;
  private readonly startGate = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });

  /**
   * Releases the blocked fake turn.
   */
  public release(): void {
    this.releaseStart?.();
  }

  /**
   * Waits until the delayed executor has accepted the turn.
   */
  public async waitForStart(): Promise<void> {
    while (this.starts === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /**
   * Delays a turn until the test releases it.
   */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.starts += 1;
    await this.startGate;
    await super.startTurn(store, turnId, input, context);
  }
}

class InteractiveTurnExecutor extends FakeTurnExecutor {
  public interrupts = 0;
  public userInputResponses = 0;

  /**
   * Counts one interrupt command before delegating to the fake executor.
   */
  public override async interruptTurn(
    store: FsStore,
    turnId: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    this.interrupts += 1;
    await super.interruptTurn(store, turnId, context);
  }

  /**
   * Records one follow-up answer and resumes the turn.
   */
  public async respondUserInput(
    store: FsStore,
    turnId: string,
    _input: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<unknown> {
    this.userInputResponses += 1;
    const turn = store.updateTurn(turnId, { status: 'running', humanGate: null });
    store.emitTurnEvent(turnId, {
      event: 'turn.updated',
      requestId: context.requestId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
      data: { type: 'turn-updated', turn },
    });
    return turn;
  }
}

class ApprovalTurnExecutor extends FakeTurnExecutor {
  public override readonly capabilities = {
    approvals: true,
    interrupts: true,
    artifacts: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
    questions: false,
  };
  public approvalResponses = 0;

  /**
   * Records one approval response and returns the stored approval.
   */
  public async respondApproval(
    store: FsStore,
    approvalRequestId: string,
    decision: 'granted' | 'denied',
    _context: TurnCommandRuntimeContext = { requestId: null }
  ) {
    this.approvalResponses += 1;
    return store.updateApproval(approvalRequestId, {
      status: decision,
      resolvedAt: new Date().toISOString(),
    });
  }
}

/**
 * JSON request headers used by route tests.
 */
function jsonHeaders(): HeadersInit {
  return { 'content-type': 'application/json' };
}

class BrokenWorkspaceListStore extends FsStore {
  /**
   * Simulates a workspace load failure after route dispatch.
   *
   * @returns Never returns.
   */
  public override listWorkspaces(): never {
    throw new Error('Workspace storage failed.');
  }
}

/**
 * Builds a workspace synchronization review item for route-level export/import tests.
 *
 * @returns Schema-valid workspace sync review item.
 */
function workspaceSyncReviewRouteItem(): Parameters<typeof recordWorkspaceSyncReview>[1]['item'] {
  const patchText = 'diff --git a/docs/sync.md b/docs/sync.md\n';
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;

  return {
    artifactId: 'ar_workspace_review_route',
    changeSet: {
      artifactIds: ['ar_workspace_review_route'],
      base: { commit: 'abc123', contentDigest: null },
      bundle: null,
      changedPaths: [{ binary: false, path: 'docs/sync.md', status: 'modified' }],
      createdAt: '2026-07-06T00:00:00.000Z',
      evidenceRefs: [{ kind: 'worker', ref: 'turn_route_1' }],
      head: { commit: 'def456', contentDigest: null },
      id: 'wcs_route_1',
      inputSnapshotId: 'wis_route_1',
      materializationRecordId: 'wmr_route_1',
      patch: {
        bytes: Buffer.byteLength(patchText, 'utf8'),
        digest: patchDigest,
        ref: 'artifact://route-patch',
      },
      redaction: { notes: [], status: 'redacted' },
      resourceId: 'repo_default',
      strategy: 'git',
      workspaceId: 'ws_demo',
    },
    patchPayload: {
      bytes: Buffer.byteLength(patchText, 'utf8'),
      digest: patchDigest,
      mediaType: 'text/x-diff',
      text: patchText,
    },
    review: {
      actionCenterRowId: 'workspace-review:swr_route_1',
      changeSetId: 'wcs_route_1',
      createdAt: '2026-07-06T00:00:00.000Z',
      diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
      id: 'swr_route_1',
      riskSummary: '1 changed path staged for route import coverage.',
      staging: {
        branch: null,
        ref: 'staging://workspace/wcs_route_1',
        strategy: 'git_worktree',
      },
      status: 'pending',
      updatedAt: '2026-07-06T00:00:00.000Z',
      validation: [],
      workspaceId: 'ws_demo',
    },
  };
}

/**
 * Creates one linked Git repository and artifact-backed workspace review for route safety tests.
 *
 * @param input Review identity, patch, manifest, and repository behavior overrides.
 * @returns App, storage, repository, and review handles owned by the fixture.
 */
async function createGitWorkspaceReviewFixture(input: {
  readonly changedPaths?: readonly {
    readonly binary: boolean;
    readonly path: string;
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'mode_changed';
  }[];
  readonly patchText?: string;
  readonly reviewId: string;
  readonly stagingStrategy?: 'review-branch' | 'staging-root';
}): Promise<{
  readonly app: ReturnType<typeof createApp>;
  readonly artifactId: string;
  readonly baseCommit: string;
  readonly coreDb: CoreDb;
  readonly repoDir: string;
  readonly review: Parameters<typeof recordWorkspaceSyncReview>[1]['item'];
  readonly store: FsStore;
  readonly workspaceId: string;
}> {
  const coreDb = createCoreDb();
  const store = createDemoStore();
  const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
  const workspace = store.createWorkspace(`Git review ${input.reviewId}`);
  const thread = store.createThread(workspace.id, `Review ${input.reviewId}`);
  const turn = store.createTurn(workspace.id, thread.id, `Produce ${input.reviewId}`);
  const repoDir = mkdtempSync(join(tmpdir(), `openkit-${input.reviewId}-`));
  const timestamp = new Date().toISOString();

  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'repository-local@example.invalid'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Repository Local'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
  const link = await app.request(`/api/app/workspaces/${workspace.id}/repositories/default`, {
    method: 'POST',
    body: JSON.stringify({
      displayName: `Repository ${input.reviewId}`,
      git: {
        authorEmail: 'approver@example.invalid',
        authorName: 'Approving Human',
        commitOnApply: true,
        stagingStrategy: input.stagingStrategy ?? 'staging-root',
      },
      localPath: repoDir,
    }),
    headers: { 'content-type': 'application/json' },
  });

  if (link.status !== 200) {
    throw new Error(`Failed to link Git review fixture: ${await link.text()}`);
  }

  const artifactId = `ar_${input.reviewId}`;
  const patchText =
    input.patchText ??
    'diff --git a/README.md b/README.md\n' +
      '--- a/README.md\n' +
      '+++ b/README.md\n' +
      '@@ -1 +1,3 @@\n' +
      ' # Demo\n' +
      '+\n' +
      `+Applied by ${input.reviewId}.`;
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
  const review = {
    artifactId,
    changeSet: {
      artifactIds: [artifactId],
      base: { commit: baseCommit, contentDigest: null },
      bundle: null,
      changedPaths: [
        ...(input.changedPaths ?? [
          { binary: false, path: 'README.md', status: 'modified' as const },
        ]),
      ],
      createdAt: timestamp,
      evidenceRefs: [{ kind: 'worker', ref: turn.id }],
      head: { commit: 'worker-head', contentDigest: null },
      id: `wcs_${input.reviewId}`,
      inputSnapshotId: `wis_${input.reviewId}`,
      materializationRecordId: `wmr_${input.reviewId}`,
      patch: {
        bytes: Buffer.byteLength(patchText, 'utf8'),
        digest: patchDigest,
        ref: 'worker-session://workspace.patch',
      },
      redaction: { notes: [], status: 'redacted' as const },
      resourceId: 'repo_default',
      strategy: 'git' as const,
      workspaceId: workspace.id,
    },
    patchPayload: {
      bytes: Buffer.byteLength(patchText, 'utf8'),
      digest: patchDigest,
      mediaType: 'text/x-diff' as const,
      text: patchText,
    },
    review: {
      actionCenterRowId: `workspace-review:${input.reviewId}`,
      changeSetId: `wcs_${input.reviewId}`,
      createdAt: timestamp,
      diffSummary: {
        additions: 2,
        deletions: 0,
        filesChanged: input.changedPaths?.length ?? 1,
      },
      id: input.reviewId,
      riskSummary: 'Workspace changes require review.',
      staging: {
        branch:
          (input.stagingStrategy ?? 'staging-root') === 'review-branch'
            ? `openkit/review/${input.reviewId}`
            : null,
        ref: `staging://workspace/${input.reviewId}`,
        strategy: 'git_worktree' as const,
      },
      status: 'pending' as const,
      updatedAt: timestamp,
      validation: [],
      workspaceId: workspace.id,
    },
  };

  store.createArtifact({
    id: artifactId,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    kind: 'diff',
    title: 'Workspace changes ready for review',
    status: 'ready',
    summary: review.review.riskSummary,
    version: 1,
    content: { format: 'json', body: JSON.stringify(review) },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
  try {
    recordTestWorkspaceReviewMaterialization(workspaceDb, review);
  } finally {
    workspaceDb.sqlite.close();
  }

  return { app, artifactId, baseCommit, coreDb, repoDir, review, store, workspaceId: workspace.id };
}

describe('nanocore server', () => {
  it('lists seeded workspaces', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/workspaces');

    expect(res.status).toBe(200);
  });

  it('returns protocol JSON when workspace listing fails', async () => {
    const app = createApp({
      store: new BrokenWorkspaceListStore(),
      turnExecutor: new FakeTurnExecutor(),
    });
    const res = await app.request('/api/workspaces');

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({
      code: 'workspace_list_failed',
      message: 'Workspace storage failed.',
    });
  });

  it('rejects product work when boot readiness closes product admission', async () => {
    const app = createApp({
      bootReadiness: computeBootReadinessSnapshot({
        bootId: 'boot_failed',
        subsystems: {
          storage: {
            state: 'failed',
            reasons: [
              {
                code: 'storage.failed',
                message: 'Storage is unavailable.',
                blocks: ['product_work'],
              },
            ],
          },
        },
      }),
      turnExecutor: new FakeTurnExecutor(),
    });

    const diagnostics = await app.request('/api/app/diagnostics');
    const read = await app.request('/api/workspaces');
    const write = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Blocked Workspace' }),
    });
    const gateway = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ content: 'Hello', role: 'user' }], model: 'gpt-test' }),
    });
    const responses = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', model: 'gpt-test' }),
    });
    const quickChat = await app.request('/api/app/quick-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', workspaceId: 'ws_blocked' }),
    });
    const turn = await app.request('/api/turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: 'Hello',
        threadId: 'th_blocked',
        workspaceId: 'ws_blocked',
      }),
    });

    expect(diagnostics.status).toBe(200);
    expect(read.status).toBe(200);
    expect(write.status).toBe(503);
    await expect(write.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(gateway.status).toBe(503);
    await expect(gateway.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(responses.status).toBe(503);
    await expect(responses.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(quickChat.status).toBe(503);
    await expect(quickChat.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
    expect(turn.status).toBe(503);
    await expect(turn.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
  });

  it('uses the latest boot readiness for product admission and diagnostics', async () => {
    let bootReadiness = computeBootReadinessSnapshot({ bootId: 'boot_dynamic' });
    const app = createApp({
      getBootReadiness: () => bootReadiness,
      turnExecutor: new FakeTurnExecutor(),
    });

    bootReadiness = createShutdownReadinessSnapshot(bootReadiness);

    const diagnostics = await app.request('/api/app/diagnostics');
    const write = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Blocked Workspace' }),
    });

    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({
      boot: {
        acceptingProductWork: false,
        subsystems: {
          scheduler: {
            reasons: [expect.objectContaining({ code: 'shutdown.in_progress' })],
          },
        },
      },
    });
    expect(write.status).toBe(503);
    await expect(write.json()).resolves.toMatchObject({
      code: 'product_work_unavailable',
    });
  });

  it('exposes the storage layout report through the App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-storage-report-route-'));
    mkdirSync(join(dataRoot, 'server', 'quarantine'), { recursive: true });
    writeFileSync(join(dataRoot, 'server', 'quarantine', '1-core.sqlite'), 'demo');
    const app = createApp({ dataRoot });

    const res = await app.request('/api/app/storage/layout-report');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      dataRoot,
      serverDb: {
        path: 'server/db/core.sqlite',
        exists: false,
        appliedMigrations: [],
      },
      quarantineEntries: [
        {
          scope: 'server',
          path: 'server/quarantine/1-core.sqlite',
          bytes: 4,
        },
      ],
    });
  });

  it('creates and verifies data-root hot backups through server-managed handles', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-backup-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    coreDb.sqlite.close();
    const app = createApp({ dataRoot });

    const createRes = await app.request('/api/app/data-root/backups', { method: 'POST' });

    expect(createRes.status).toBe(200);
    const created = DataRootBackupCreateResponseSchema.parse(await createRes.json());
    expect(created).toMatchObject({
      manifest: {
        recordType: 'data-root-backup',
        backupMode: 'hot',
        consistency: 'crash-consistent',
      },
    });
    expect(created.checkedFiles).toContain('server/db/core.sqlite');
    expect(JSON.stringify(created)).not.toContain(dataRoot);

    const verifyRes = await app.request(`/api/app/data-root/backups/${created.backupId}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupId: created.backupId }),
    });

    expect(verifyRes.status).toBe(200);
    const verified = DataRootBackupVerifyResponseSchema.parse(await verifyRes.json());
    expect(verified).toMatchObject({ backupId: created.backupId, fileCount: created.fileCount });
    expect(JSON.stringify(verified)).not.toContain(dataRoot);
  });

  it('exports one workspace through the App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-route-'));
    const store = createDemoStore({ dataRoot });
    store.createThread('ws_demo', 'Export route thread');
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Export route knowledge',
      content: 'Export this note.',
    });
    const app = createApp({ dataRoot, store });

    const res = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = WorkspaceExportResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      workspaceId: 'ws_demo',
      fileCount: 14,
      checkedFiles: [
        'records/agent-sessions.jsonl',
        'records/artifact-reviews.jsonl',
        'records/item-revisions.jsonl',
        'records/knowledge-claims.jsonl',
        'records/knowledge-conflicts.jsonl',
        'records/knowledge-context-package-traces.jsonl',
        'records/knowledge-observations.jsonl',
        'records/knowledge-retrieval-traces.jsonl',
        'records/knowledge.jsonl',
        'records/threads.jsonl',
        'records/turn-events.jsonl',
        'records/turns.jsonl',
        'records/workspace.json',
        'workspace-files/knowledge/schema/workspace-schema.yaml',
      ],
      manifest: {
        recordType: 'workspace-export',
        workspaceId: 'ws_demo',
        exportFormatVersion: 2,
      },
    });
    expect(JSON.stringify(body)).not.toContain(dataRoot);
  });

  it('dry-runs workspace import through the App API without creating a workspace', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-dry-run-route-'));
    const store = createDemoStore({ dataRoot });
    const app = createApp({ dataRoot, store });
    const beforeCount = store.listWorkspaces().length;
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    const dryRunRes = await app.request('/api/app/workspace-imports/dry-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceWorkspaceId: 'ws_demo', exportId: exported.exportId }),
    });

    expect(dryRunRes.status).toBe(200);
    const body = WorkspaceImportDryRunResponseSchema.parse(await dryRunRes.json());
    expect(body).toMatchObject({
      mode: 'dry-run',
      exportId: exported.exportId,
      sourceWorkspaceId: 'ws_demo',
      exportedWorkspaceId: 'ws_demo',
      collision: { status: 'collides', workspaceId: 'ws_demo' },
      verification: { fileCount: 14 },
    });
    expect(store.listWorkspaces()).toHaveLength(beforeCount);
    expect(JSON.stringify(body)).not.toContain(dataRoot);
  });

  it('imports one workspace through the App API with collision reminting', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createThread('ws_demo', 'Import source thread');
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Import source knowledge',
      content: 'Import this knowledge.',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const sourceDeploymentId = readDataRootLayoutMarker(dataRoot).deploymentId;
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d701',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    expect(body).toMatchObject({
      mode: 'imported',
      requestId: '00000000-0000-4000-8000-00000000d701',
      sourceWorkspaceId: 'ws_demo',
      exportedWorkspaceId: 'ws_demo',
      importedWorkspaceId: 'ws_imported_ws_demo',
      collision: { status: 'collides', workspaceId: 'ws_demo' },
      workspace: {
        id: 'ws_imported_ws_demo',
        counts: { threadCount: 2, knowledgeEntryCount: 2 },
        importedFrom: {
          sourceDeploymentId,
          sourceWorkspaceId: 'ws_demo',
          exportCreatedAt: exported.manifest.exportCreatedAt,
        },
      },
    });
    expect(body.workspace.importedFrom?.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(store.getWorkspace('ws_imported_ws_demo').name).toBe('Demo Workspace');
    expect(store.getWorkspace('ws_imported_ws_demo').importedFrom?.sourceWorkspaceId).toBe(
      'ws_demo'
    );
    expect(store.listThreads('ws_imported_ws_demo')).toHaveLength(2);
    expect(store.listKnowledge('ws_imported_ws_demo').map((entry) => entry.title)).toContain(
      'Import source knowledge'
    );
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT user_id, status
           FROM workspace_members
           WHERE workspace_id = ?`
        )
        .get(body.importedWorkspaceId)
    ).toEqual({ status: 'active', user_id: 'user_local' });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_imported_ws_demo');
    try {
      const audit = workspaceDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE action = ?')
        .get('workspace.import') as Record<string, unknown> | undefined;
      expect(audit).toMatchObject({
        workspace_id: 'ws_imported_ws_demo',
        request_id: '00000000-0000-4000-8000-00000000d701',
        category: 'system',
        resource: 'workspace:ws_imported_ws_demo',
        outcome: 'succeeded',
        severity: 'info',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
    expect(JSON.stringify(body)).not.toContain(dataRoot);
  });

  it('exports and imports workspace audit events as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-audit-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordWorkspaceAuditEvent({
        workspaceDb: sourceDb,
        auditEventId: 'aud_workspace_source_event',
        workspaceId: 'ws_demo',
        requestId: '00000000-0000-4000-8000-00000000d721',
        category: 'system',
        action: 'workspace.source_event',
        resource: 'workspace:ws_demo',
        outcome: 'succeeded',
        severity: 'info',
        summary: 'Source workspace event.',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/audit-events.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d722',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      const auditRows = importedDb.sqlite
        .prepare(
          'SELECT audit_event_id, workspace_id, request_id, action, resource FROM audit_events ORDER BY action DESC'
        )
        .all() as Array<Record<string, unknown>>;

      expect(auditRows).toHaveLength(3);
      expect(auditRows).toEqual(
        expect.arrayContaining([
          {
            audit_event_id: 'aud_workspace_source_event',
            workspace_id: body.importedWorkspaceId,
            request_id: '00000000-0000-4000-8000-00000000d721',
            action: 'workspace.source_event',
            resource: `workspace:${body.importedWorkspaceId}`,
          },
          expect.objectContaining({
            workspace_id: body.importedWorkspaceId,
            request_id: '00000000-0000-4000-8000-00000000d722',
            action: 'workspace.import',
            resource: `workspace:${body.importedWorkspaceId}`,
          }),
          expect.objectContaining({
            workspace_id: body.importedWorkspaceId,
            request_id: '00000000-0000-4000-8000-00000000d722',
            action: 'capability.finish',
            resource: 'capability:storage.workspace_import',
          }),
        ])
      );
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('uses the data-root deployment id for workspace export lineage', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    recordDataRootDeploymentMove(dataRoot, 'dep_moved');
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });

      expect(exportRes.status).toBe(200);
      const body = WorkspaceExportResponseSchema.parse(await exportRes.json());
      expect(body.manifest.sourceDeploymentId).toBe('dep_moved');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records storage usage when a workspace export is written', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-storage-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
      const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
      const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');

      expect(usageRes.status, await usageRes.clone().text()).toBe(200);
      const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
      expect(usage.capabilityCalls).toEqual([
        expect.objectContaining({
          capabilityId: 'storage.workspace_export',
          family: 'storage',
          operation: 'workspace.export.write',
          providerRef: 'nanocore-storage',
          serviceRef: 'workspace-export',
          status: 'succeeded',
          workspaceId: 'ws_demo',
        }),
      ]);
      expect(usage.usageRecords).toHaveLength(2);
      expect(usage.usageRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'storage',
            providerRef: 'nanocore-storage',
            quantity: exported.fileCount,
            source: 'workspace-export-inventory',
            unit: 'files',
            workspaceId: 'ws_demo',
          }),
          expect.objectContaining({
            category: 'storage',
            providerRef: 'nanocore-storage',
            quantity: exported.totalBytes,
            source: 'workspace-export-inventory',
            unit: 'bytes',
            workspaceId: 'ws_demo',
          }),
        ])
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records storage usage when a workspace import is written', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-storage-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
      const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
      const importRes = await app.request('/api/app/workspace-imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceWorkspaceId: 'ws_demo',
          exportId: exported.exportId,
          requestId: '00000000-0000-4000-8000-00000000d733',
        }),
      });

      expect(importRes.status, await importRes.clone().text()).toBe(200);
      const imported = WorkspaceImportResponseSchema.parse(await importRes.json());
      const usageRes = await app.request(
        `/api/app/workspaces/${imported.importedWorkspaceId}/capability-usage`
      );

      expect(usageRes.status, await usageRes.clone().text()).toBe(200);
      const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
      expect(usage.capabilityCalls).toEqual([
        expect.objectContaining({
          capabilityId: 'storage.workspace_import',
          family: 'storage',
          operation: 'workspace.import.write',
          providerRef: 'nanocore-storage',
          serviceRef: 'workspace-import',
          status: 'succeeded',
          workspaceId: imported.importedWorkspaceId,
        }),
      ]);
      expect(usage.usageRecords).toHaveLength(2);
      expect(usage.usageRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'storage',
            providerRef: 'nanocore-storage',
            quantity: imported.verification.fileCount,
            source: 'workspace-import-inventory',
            unit: 'files',
            workspaceId: imported.importedWorkspaceId,
          }),
          expect.objectContaining({
            category: 'storage',
            providerRef: 'nanocore-storage',
            quantity: imported.verification.totalBytes,
            source: 'workspace-import-inventory',
            unit: 'bytes',
            workspaceId: imported.importedWorkspaceId,
          }),
        ])
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('exports and imports capability usage ledger rows as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-usage-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    let callId = '';
    try {
      const call = startCapabilityCall({
        workspaceDb: sourceDb,
        callId: 'cap_workspace_source_call',
        workspaceId: 'ws_demo',
        requestId: '00000000-0000-4000-8000-00000000d731',
        family: 'llm',
        operation: 'quick_chat',
        capabilityId: 'inference.local.quick_chat',
        redactionClass: 'metadata',
        summary: 'Source capability call.',
        providerRef: 'provider:test',
        now: new Date('2026-07-06T00:00:00.000Z'),
      });
      callId = call.id;
      recordUsage({
        workspaceDb: sourceDb,
        call,
        records: [
          {
            usageId: 'use_workspace_source_usage',
            category: 'llm',
            unit: 'tokens',
            quantity: 42,
            modelId: 'model_test',
            providerRef: 'provider:test',
            source: 'unit-test',
          },
        ],
        now: new Date('2026-07-06T00:00:01.000Z'),
      });
      finishCapabilityCall({
        workspaceDb: sourceDb,
        callId,
        status: 'succeeded',
        now: new Date('2026-07-06T00:00:02.000Z'),
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/capability-calls.jsonl');
    expect(exported.checkedFiles).toContain('records/usage-records.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d732',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      const callRow = importedDb.sqlite
        .prepare(
          'SELECT call_id, workspace_id, capability_id, status, provider_ref FROM capability_calls WHERE call_id = ?'
        )
        .get(callId) as Record<string, unknown> | undefined;
      const usageRow = importedDb.sqlite
        .prepare(
          'SELECT usage_id, workspace_id, capability_call_id, category, unit, quantity FROM usage_records WHERE usage_id = ?'
        )
        .get('use_workspace_source_usage') as Record<string, unknown> | undefined;

      expect(callRow).toEqual({
        call_id: callId,
        workspace_id: body.importedWorkspaceId,
        capability_id: 'inference.local.quick_chat',
        status: 'succeeded',
        provider_ref: 'provider:test',
      });
      expect(usageRow).toEqual({
        usage_id: 'use_workspace_source_usage',
        workspace_id: body.importedWorkspaceId,
        capability_call_id: callId,
        category: 'llm',
        unit: 'tokens',
        quantity: 42,
      });
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports knowledge proposal and source records as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-knowledge-state-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createKnowledgeProposal({
      id: 'kp_source_1',
      workspaceId: 'ws_demo',
      title: 'Capture deployment note',
      summary: 'Remember the deployment checkpoint.',
      status: 'pending',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });
    store.recordKnowledgeProposalReviewDecision({
      proposalId: 'kp_source_1',
      workspaceId: 'ws_demo',
      status: 'accepted',
      requestId: '00000000-0000-4000-8000-00000000d735',
      message: 'Accept the deployment note.',
      decidedAt: '2026-07-06T00:00:01.000Z',
    });
    store.createKnowledgeSource(
      {
        id: 'ks_source_1',
        workspaceId: 'ws_demo',
        kind: 'document',
        title: 'Deployment note',
        uri: 'workspace://ws_demo/docs/deployment.md',
        contentDigest: 'sha256:deployment-note',
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: '2026-07-06T00:00:02.000Z',
        createdAt: '2026-07-06T00:00:02.000Z',
        updatedAt: '2026-07-06T00:00:02.000Z',
      },
      'Deployment note source material.'
    );
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/knowledge-proposals.jsonl');
    expect(exported.checkedFiles).toContain('records/knowledge-proposal-reviews.jsonl');
    expect(exported.checkedFiles).toContain('records/knowledge-sources.jsonl');
    expect(exported.checkedFiles).toContain('sources/materials/ks_source_1/content.txt');
    expect(exported.checkedFiles).toContain('sources/derived/ks_source_1/text.json');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d736',
      }),
    });

    expect(importRes.status).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    expect(store.listKnowledgeProposals(body.importedWorkspaceId)).toEqual([
      expect.objectContaining({
        id: 'kp_imported_ws_imported_ws_demo_1',
        workspaceId: body.importedWorkspaceId,
        status: 'accepted',
      }),
    ]);
    expect(store.listKnowledgeProposalReviewDecisions(body.importedWorkspaceId)).toEqual([
      expect.objectContaining({
        proposalId: 'kp_imported_ws_imported_ws_demo_1',
        workspaceId: body.importedWorkspaceId,
        status: 'accepted',
        requestId: '00000000-0000-4000-8000-00000000d735',
      }),
    ]);
    expect(store.listKnowledgeSources(body.importedWorkspaceId)).toEqual([
      expect.objectContaining({
        id: 'ks_imported_ws_imported_ws_demo_1',
        workspaceId: body.importedWorkspaceId,
        kind: 'document',
        contentDigest: 'sha256:deployment-note',
      }),
    ]);
    expect(
      store.readKnowledgeSourceMaterial(
        body.importedWorkspaceId,
        'ks_imported_ws_imported_ws_demo_1'
      )
    ).toBe('Deployment note source material.');
    expect(
      store.listKnowledgeSourceDerivedRepresentations(
        body.importedWorkspaceId,
        'ks_imported_ws_imported_ws_demo_1'
      )
    ).toEqual([
      expect.objectContaining({
        sourceId: 'ks_imported_ws_imported_ws_demo_1',
        kind: 'text',
        materialPath: 'sources/materials/ks_imported_ws_imported_ws_demo_1/content.txt',
      }),
    ]);
    expect(store.getKnowledgeProposal('kp_source_1')?.workspaceId).toBe('ws_demo');
    expect(store.getKnowledgeSource('ws_demo', 'ks_source_1').workspaceId).toBe('ws_demo');
    expect(JSON.stringify(exported)).not.toContain(dataRoot);
    coreDb.sqlite.close();
  });

  it('round-trips representative workspace records through export import export', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-round-trip-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createThread('ws_demo', 'Round trip thread');
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Round trip knowledge',
      content: 'Keep this entry through import.',
    });
    store.createKnowledgeProposal({
      id: 'kp_round_trip_1',
      workspaceId: 'ws_demo',
      title: 'Round trip proposal',
      summary: 'Keep this proposal through import.',
      status: 'pending',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });
    store.recordKnowledgeProposalReviewDecision({
      proposalId: 'kp_round_trip_1',
      workspaceId: 'ws_demo',
      status: 'accepted',
      requestId: '00000000-0000-4000-8000-00000000d745',
      message: 'Accept the round-trip proposal.',
      decidedAt: '2026-07-06T00:00:01.000Z',
    });
    store.createKnowledgeSource({
      id: 'ks_round_trip_1',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Round trip source',
      uri: 'workspace://ws_demo/docs/round-trip.md',
      contentDigest: 'sha256:round-trip-source',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: '2026-07-06T00:00:02.000Z',
      createdAt: '2026-07-06T00:00:02.000Z',
      updatedAt: '2026-07-06T00:00:02.000Z',
    });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'os-keychain',
      backendLocator: 'os-keychain:round-trip-source',
      displayName: 'Round trip provider key',
      ownerScope: 'workspace',
      referenceId: 'vault_round_trip_provider',
      secretKind: 'provider-api-key',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:03.000Z',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkspaceRepositoryResource(sourceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
        resourceId: 'repo_round_trip',
        displayName: 'Round trip repository',
        localPath: dataRoot,
        git: {
          allowedPushTargets: ['main'],
          authorEmail: 'openkit@example.com',
          authorName: 'OpenKit Bot',
          commitOnApply: true,
          protectedBranchPatterns: ['main', 'release/*'],
          requireReviewLinkage: false,
          stagingStrategy: 'review-branch',
        },
        now: () => '2026-07-06T00:00:03.000Z',
      });
      recordWorkspaceAuditEvent({
        workspaceDb: sourceDb,
        auditEventId: 'aud_round_trip_source',
        workspaceId: 'ws_demo',
        requestId: '00000000-0000-4000-8000-00000000d746',
        category: 'system',
        action: 'workspace.round_trip_source',
        resource: 'workspace:ws_demo',
        outcome: 'succeeded',
        severity: 'info',
        summary: 'Round-trip source event.',
        now: new Date('2026-07-06T00:00:04.000Z'),
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });

    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
    const sourceRoot = workspaceExportRoot(dataRoot, 'ws_demo', exported.exportId);
    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d747',
      }),
    });
    const importPayload = await importRes.json();
    expect(importRes.status, JSON.stringify(importPayload)).toBe(200);
    const imported = WorkspaceImportResponseSchema.parse(importPayload);
    const reExportRes = await app.request(
      `/api/app/workspaces/${imported.importedWorkspaceId}/export`,
      { method: 'POST' }
    );
    const reExported = WorkspaceExportResponseSchema.parse(await reExportRes.json());
    const reExportRoot = workspaceExportRoot(
      dataRoot,
      imported.importedWorkspaceId,
      reExported.exportId
    );

    expect(reExported.checkedFiles).toEqual(expect.arrayContaining(exported.checkedFiles));
    expect(readExportJson(sourceRoot, 'records/workspace.json')).toMatchObject({
      counts: readExportJson(reExportRoot, 'records/workspace.json').counts,
    });
    expect(
      readExportJsonl(reExportRoot, 'records/threads.jsonl').map((thread) => thread.name)
    ).toEqual(readExportJsonl(sourceRoot, 'records/threads.jsonl').map((thread) => thread.name));
    expect(
      readExportJsonl(reExportRoot, 'records/knowledge.jsonl').map((entry) => entry.title)
    ).toEqual(readExportJsonl(sourceRoot, 'records/knowledge.jsonl').map((entry) => entry.title));
    expect(readExportJsonl(reExportRoot, 'records/knowledge-proposals.jsonl')).toEqual([
      expect.objectContaining({
        status: 'accepted',
        summary: 'Keep this proposal through import.',
        workspaceId: imported.importedWorkspaceId,
      }),
    ]);
    expect(readExportJsonl(reExportRoot, 'records/knowledge-proposal-reviews.jsonl')).toEqual([
      expect.objectContaining({
        requestId: '00000000-0000-4000-8000-00000000d745',
        status: 'accepted',
        workspaceId: imported.importedWorkspaceId,
      }),
    ]);
    expect(readExportJsonl(reExportRoot, 'records/knowledge-sources.jsonl')).toEqual([
      expect.objectContaining({
        contentDigest: 'sha256:round-trip-source',
        uri: `workspace://${imported.importedWorkspaceId}/docs/round-trip.md`,
        workspaceId: imported.importedWorkspaceId,
      }),
    ]);
    expect(readExportJsonl(reExportRoot, 'records/audit-events.jsonl')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'workspace.round_trip_source',
          requestId: '00000000-0000-4000-8000-00000000d746',
          workspaceId: imported.importedWorkspaceId,
        }),
      ])
    );
    expect(readExportJsonl(reExportRoot, 'records/workspace-repositories.jsonl')).toEqual([
      expect.objectContaining({
        displayName: 'Round trip repository',
        git: expect.objectContaining({
          allowedPushTargets: ['main'],
          stagingStrategy: 'review-branch',
        }),
        resourceId: 'repo_round_trip',
      }),
    ]);
    expect(readExportJsonl(reExportRoot, 'records/vault-references.jsonl')).toEqual([
      expect.objectContaining({
        backendKind: sourceReference.backendKind,
        displayName: sourceReference.displayName,
        secretKind: sourceReference.secretKind,
      }),
    ]);
    expect(readExportJsonl(reExportRoot, 'records/vault-references.jsonl')[0]).not.toMatchObject({
      sourceReferenceId: sourceReference.referenceId,
    });
    expect(JSON.stringify(reExported)).not.toContain(dataRoot);
    coreDb.sqlite.close();
  });

  it('imports workspace vault references as unbound metadata', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-vault-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'os-keychain',
      backendLocator: 'os-keychain:redacted-source',
      displayName: 'Workspace provider key',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_provider',
      secretKind: 'provider-api-key',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/vault-references.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d711',
      }),
    });

    expect(importRes.status).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedReferences = listVaultReferences(coreDb).filter(
      (reference) => reference.workspaceId === body.importedWorkspaceId
    );

    expect(importedReferences).toEqual([
      expect.objectContaining({
        ownerScope: 'workspace',
        workspaceId: body.importedWorkspaceId,
        displayName: sourceReference.displayName,
        secretKind: sourceReference.secretKind,
        backendKind: sourceReference.backendKind,
        backendLocator: null,
        currentVersion: 0,
        status: 'unbound',
      }),
    ]);
    expect(importedReferences[0]?.referenceId).not.toBe(sourceReference.referenceId);
    expect(getVaultReference(coreDb, sourceReference.referenceId)).toEqual(sourceReference);
    expect(JSON.stringify(importedReferences)).not.toContain('redacted-source');
    coreDb.sqlite.close();
  });

  it('rolls back the published workspace and Core rows when Core import fails', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-core-rollback-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    for (const suffix of ['1', '2']) {
      createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        backendLocator: `encrypted-file://source-${suffix}`,
        displayName: `Workspace provider key ${suffix}`,
        ownerScope: 'workspace',
        referenceId: `vault_ws_demo_${suffix}`,
        secretKind: 'provider-api-key',
        workspaceId: 'ws_demo',
        now: () => `2026-07-06T00:00:0${suffix}.000Z`,
      });
    }
    const targetWorkspaceId = 'ws_imported_ws_demo';
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://conflict',
      displayName: 'Conflicting server reference',
      ownerScope: 'server',
      referenceId: `vault_imported_${targetWorkspaceId}_2`,
      secretKind: 'provider-api-key',
      now: () => '2026-07-06T00:00:03.000Z',
    });
    const coreRowCounts = coreDb.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM vault_references) AS vaultReferences,
      (SELECT COUNT(*) FROM vault_grants) AS vaultGrants,
      (SELECT COUNT(*) FROM injection_plans) AS injectionPlans,
      (SELECT COUNT(*) FROM injection_receipts) AS injectionReceipts`);
    const beforeCoreRows = coreRowCounts.get();
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d712',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(400);
    expect({
      coreRows: coreRowCounts.get(),
      finalWorkspaceRootExists: existsSync(
        join(dataRoot, 'users', LOCAL_USER_ID, 'workspaces', targetWorkspaceId)
      ),
      storeHasWorkspace: store
        .listWorkspaces()
        .some((workspace) => workspace.id === targetWorkspaceId),
    }).toEqual({
      coreRows: beforeCoreRows,
      finalWorkspaceRootExists: false,
      storeHasWorkspace: false,
    });
    coreDb.sqlite.close();
  });

  it('exports and imports workspace vault use records as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-vault-use-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://redacted-source',
      displayName: 'Workspace GitHub token',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_github',
      secretKind: 'github-token',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createVaultUseRecord(sourceDb, {
        useId: 'vuse_ws_demo_1',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        vaultReferenceId: 'vault_ws_demo_github',
        materialVersion: 3,
        backendKind: 'encrypted-file',
        resolvingPath: 'provider',
        capabilityCallId: 'cap_vault_1',
        outcome: 'succeeded',
        auditEventId: 'audit_vault_1',
        usedAt: '2026-07-06T00:10:00.000Z',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/vault-use-records.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d842',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedReferences = listVaultReferences(coreDb).filter(
      (reference) => reference.workspaceId === body.importedWorkspaceId
    );
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(listVaultUseRecords(importedDb)).toEqual([
        expect.objectContaining({
          useId: 'vuse_ws_demo_1',
          ownerScope: 'workspace',
          workspaceId: body.importedWorkspaceId,
          vaultReferenceId: importedReferences[0]?.referenceId,
          materialVersion: 3,
          backendKind: 'encrypted-file',
          resolvingPath: 'provider',
          grantId: null,
          receiptId: null,
          outcome: 'succeeded',
          auditEventId: 'audit_vault_1',
        }),
      ]);
      expect(JSON.stringify(listVaultUseRecords(importedDb))).not.toContain('redacted-source');
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace vault grants as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-vault-grant-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://redacted-source',
      displayName: 'Workspace GitHub token',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_github',
      secretKind: 'github-token',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    createVaultGrant(coreDb, {
      grantId: 'grant_ws_demo_github',
      vaultReferenceId: sourceReference.referenceId,
      ownerScope: 'workspace',
      workspaceId: 'ws_demo',
      subjectSummary: 'GitHub MCP read access',
      targetAgentId: 'assistant',
      targetCapabilityId: 'mcp.github.call_tool',
      allowedInjectionPaths: ['backend-provider'],
      lifetime: 'workspace',
      policyDecisionId: 'pd_grant_1',
      expiresAt: '2026-07-07T00:00:00.000Z',
      now: () => '2026-07-06T00:11:00.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/vault-grants.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d852',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedReference = listVaultReferences(coreDb).find(
      (reference) => reference.workspaceId === body.importedWorkspaceId
    );
    const importedGrants = listVaultGrants(coreDb).filter(
      (grant) => grant.workspaceId === body.importedWorkspaceId
    );

    expect(importedGrants).toEqual([
      expect.objectContaining({
        grantId: `grant_imported_${body.importedWorkspaceId}_1`,
        vaultReferenceId: importedReference?.referenceId,
        ownerScope: 'workspace',
        workspaceId: body.importedWorkspaceId,
        subjectSummary: 'GitHub MCP read access',
        allowedInjectionPaths: ['backend-provider'],
        lifetime: 'workspace',
        status: 'active',
        policyDecisionId: 'pd_grant_1',
        approvalId: null,
        expiresAt: '2026-07-07T00:00:00.000Z',
      }),
    ]);
    expect(importedGrants[0]?.grantId).not.toBe('grant_ws_demo_github');
    expect(importedGrants[0]?.vaultReferenceId).not.toBe(sourceReference.referenceId);
    expect(JSON.stringify(importedGrants)).not.toContain('redacted-source');
    coreDb.sqlite.close();
  });

  it('exports and imports workspace injection plans as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-injection-plan-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://redacted-source',
      displayName: 'Workspace Codex auth',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_codex_auth',
      secretKind: 'codex-auth-json',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    createVaultGrant(coreDb, {
      grantId: 'grant_ws_demo_codex_auth',
      vaultReferenceId: sourceReference.referenceId,
      ownerScope: 'workspace',
      workspaceId: 'ws_demo',
      subjectSummary: 'Codex auth runtime file',
      allowedInjectionPaths: ['runtime-file'],
      lifetime: 'agent-session',
      policyDecisionId: 'pd_plan_1',
      now: () => '2026-07-06T00:12:00.000Z',
    });
    createInjectionPlan(coreDb, {
      planId: 'plan_ws_demo_codex_auth',
      grantId: 'grant_ws_demo_codex_auth',
      capabilityId: 'runtime.codex_auth',
      injectionVisibility: 'runtime-file',
      targetPath: '/sandbox/.codex/auth.json',
      expirationBehavior: 'expire-with-agent-session',
      revocationBehavior: 'mark-stale-session',
      redactionRule: 'path-only',
      backendCapabilityRequirement: 'runtime-file-upload',
      now: () => '2026-07-06T00:12:01.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/injection-plans.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d862',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedGrant = listVaultGrants(coreDb).find(
      (grant) => grant.workspaceId === body.importedWorkspaceId
    );
    const importedPlans = listInjectionPlans(coreDb).filter(
      (plan) => plan.grantId === importedGrant?.grantId
    );

    expect(importedPlans).toEqual([
      expect.objectContaining({
        planId: `plan_imported_${body.importedWorkspaceId}_1`,
        grantId: importedGrant?.grantId,
        packageSnapshotId: null,
        capabilityId: 'runtime.codex_auth',
        injectionVisibility: 'runtime-file',
        targetPath: '/sandbox/.codex/auth.json',
        targetEnvVarName: null,
        expirationBehavior: 'expire-with-agent-session',
        revocationBehavior: 'mark-stale-session',
        redactionRule: 'path-only',
        backendCapabilityRequirement: 'runtime-file-upload',
        status: 'active',
      }),
    ]);
    expect(importedPlans[0]?.planId).not.toBe('plan_ws_demo_codex_auth');
    expect(importedPlans[0]?.grantId).not.toBe('grant_ws_demo_codex_auth');
    expect(JSON.stringify(importedPlans)).not.toContain('redacted-source');
    coreDb.sqlite.close();
  });

  it('exports and imports workspace injection receipts as line-oriented records', async () => {
    const dataRoot = mkdtempSync(
      join(tmpdir(), 'openkit-workspace-import-injection-receipt-route-')
    );
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceReference = createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://redacted-source',
      displayName: 'Workspace GitHub token',
      ownerScope: 'workspace',
      referenceId: 'vault_ws_demo_github_receipt',
      secretKind: 'github-token',
      workspaceId: 'ws_demo',
      now: () => '2026-07-06T00:00:00.000Z',
    });
    createVaultGrant(coreDb, {
      grantId: 'grant_ws_demo_github_receipt',
      vaultReferenceId: sourceReference.referenceId,
      ownerScope: 'workspace',
      workspaceId: 'ws_demo',
      subjectSummary: 'GitHub push token',
      targetCapabilityId: 'mcp.github.call_tool',
      allowedInjectionPaths: ['backend-provider'],
      lifetime: 'capability-call',
      policyDecisionId: 'pd_receipt_1',
      now: () => '2026-07-06T00:13:00.000Z',
    });
    createInjectionPlan(coreDb, {
      planId: 'plan_ws_demo_github_receipt',
      grantId: 'grant_ws_demo_github_receipt',
      capabilityId: 'mcp.github.call_tool',
      injectionVisibility: 'backend-provider',
      expirationBehavior: 'expire-after-capability-call',
      revocationBehavior: 'revoke-backend-handle',
      redactionRule: 'backend-summary-only',
      backendCapabilityRequirement: 'native-handle',
      now: () => '2026-07-06T00:13:01.000Z',
    });
    createInjectionReceipt(coreDb, {
      receiptId: 'receipt_ws_demo_github',
      planId: 'plan_ws_demo_github_receipt',
      grantId: 'grant_ws_demo_github_receipt',
      capabilityCallId: 'cap_receipt_1',
      backendSummary: 'encrypted-file material v7 injected as backend handle',
      injectedAt: '2026-07-06T00:13:02.000Z',
      expiresAt: '2026-07-06T00:18:02.000Z',
      revocationStatus: 'active',
      auditEventId: 'audit_receipt_1',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createVaultUseRecord(sourceDb, {
        useId: 'vuse_ws_demo_receipt',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        vaultReferenceId: sourceReference.referenceId,
        materialVersion: 7,
        backendKind: 'encrypted-file',
        resolvingPath: 'plan',
        planId: 'plan_ws_demo_github_receipt',
        receiptId: 'receipt_ws_demo_github',
        capabilityCallId: 'cap_receipt_1',
        outcome: 'succeeded',
        auditEventId: 'audit_vault_use_receipt_1',
        usedAt: '2026-07-06T00:13:03.000Z',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/injection-receipts.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d872',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedGrant = listVaultGrants(coreDb).find(
      (grant) => grant.workspaceId === body.importedWorkspaceId
    );
    const importedPlan = listInjectionPlans(coreDb).find(
      (plan) => plan.grantId === importedGrant?.grantId
    );
    const importedReceipts = listInjectionReceipts(coreDb).filter(
      (receipt) => receipt.planId === importedPlan?.planId
    );
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);

    try {
      expect(importedReceipts).toEqual([
        expect.objectContaining({
          receiptId: `receipt_imported_${body.importedWorkspaceId}_1`,
          planId: importedPlan?.planId,
          grantId: importedGrant?.grantId,
          agentSessionId: null,
          capabilityCallId: 'cap_receipt_1',
          backendSummary: 'encrypted-file material v7 injected as backend handle',
          injectedAt: '2026-07-06T00:13:02.000Z',
          expiresAt: '2026-07-06T00:18:02.000Z',
          revocationStatus: 'active',
          auditEventId: 'audit_receipt_1',
        }),
      ]);
      expect(listVaultUseRecords(importedDb)).toEqual([
        expect.objectContaining({
          useId: 'vuse_ws_demo_receipt',
          workspaceId: body.importedWorkspaceId,
          vaultReferenceId: importedGrant?.vaultReferenceId,
          planId: importedPlan?.planId,
          receiptId: importedReceipts[0]?.receiptId,
        }),
      ]);
      expect(importedReceipts[0]?.receiptId).not.toBe('receipt_ws_demo_github');
      expect(importedReceipts[0]?.planId).not.toBe('plan_ws_demo_github_receipt');
      expect(importedReceipts[0]?.grantId).not.toBe('grant_ws_demo_github_receipt');
      expect(JSON.stringify(importedReceipts)).not.toContain('redacted-source');
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace data source catalogs', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-data-sources-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const catalogRoot = join(dataRoot, 'users', LOCAL_USER_ID, 'workspaces', 'ws_demo', 'config');
    mkdirSync(catalogRoot, { recursive: true });
    writeFileSync(
      join(catalogRoot, 'data-sources.jsonc'),
      `${JSON.stringify(
        parseWorkspaceDataSourceCatalog({
          schemaVersion: 1,
          sources: [
            {
              id: 'repo_default',
              kind: 'git',
              displayName: 'OpenKit repository',
              locator: { repositoryResourceId: 'repo_default' },
              access: 'read-write',
              sensitivity: 'internal',
              allowedSlotKinds: ['worktree'],
              status: 'active',
            },
          ],
        }),
        null,
        2
      )}\n`
    );
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/data-sources.json');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d741',
      }),
    });

    expect(importRes.status).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedCatalog = parseWorkspaceDataSourceCatalog(
      JSON.parse(
        readFileSync(
          join(
            dataRoot,
            'users',
            LOCAL_USER_ID,
            'workspaces',
            body.importedWorkspaceId,
            'config',
            'data-sources.jsonc'
          ),
          'utf8'
        )
      )
    );

    expect(importedCatalog.sources).toEqual([
      expect.objectContaining({
        id: 'repo_default',
        kind: 'git',
        locator: { repositoryResourceId: 'repo_default' },
      }),
    ]);
    expect(JSON.stringify(exported)).not.toContain(dataRoot);
    coreDb.sqlite.close();
  });

  it('exports and imports Git push records as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-git-push-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordGitPushRecord(sourceDb, {
        requestId: '00000000-0000-4000-8000-00000000d751',
        record: {
          actorId: 'user_local',
          approvalRowId: null,
          commitIds: ['abc123'],
          createdAt: '2026-07-06T00:00:00.000Z',
          errorSummary: null,
          id: 'gpr_source_1',
          outcome: 'pushed',
          policyDecisionId: 'pd_git_push_1',
          remoteHeadAfter: 'def456',
          remoteHeadBefore: 'abc000',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          reviewIds: ['wr_review_1'],
          sourceRef: 'HEAD',
          targetBranch: 'main',
          updatedAt: '2026-07-06T00:00:01.000Z',
          workspaceId: 'ws_demo',
        },
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/git-push-records.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d752',
      }),
    });

    expect(importRes.status).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(listGitPushRecords(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'gpr_source_1',
          workspaceId: body.importedWorkspaceId,
          repositoryResourceId: 'repo_default',
          outcome: 'pushed',
          commitIds: ['abc123'],
          reviewIds: ['wr_review_1'],
        }),
      ]);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace repository resources as unbound metadata', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-repository-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkspaceRepositoryResource(sourceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
        resourceId: 'repo_default',
        displayName: 'OpenKit source',
        localPath: dataRoot,
        git: {
          allowedPushTargets: ['main'],
          authorEmail: 'openkit@example.com',
          authorName: 'OpenKit Bot',
          commitOnApply: true,
          protectedBranchPatterns: ['main', 'release/*'],
          requireReviewLinkage: false,
          stagingStrategy: 'review-branch',
        },
        now: () => '2026-07-06T00:00:00.000Z',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/workspace-repositories.jsonl');
    expect(JSON.stringify(exported)).not.toContain(dataRoot);

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d753',
      }),
    });

    expect(importRes.status).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(listWorkspaceRepositoryResources(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          workspaceId: body.importedWorkspaceId,
          resourceId: 'repo_default',
          displayName: 'OpenKit source',
          localPath: '',
          diagnosticsStatus: 'missing',
          git: {
            allowedPushTargets: ['main'],
            authorEmail: 'openkit@example.com',
            authorName: 'OpenKit Bot',
            commitOnApply: true,
            protectedBranchPatterns: ['main', 'release/*'],
            requireReviewLinkage: false,
            stagingStrategy: 'review-branch',
            vaultGrantRef: null,
          },
        }),
      ]);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace sync records as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-sync-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const sourceReview = workspaceSyncReviewRouteItem();
    const sourceTurn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Produce workspace sync review',
      null,
      {
        turnId: 'turn_route_1',
      }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: sourceReview.changeSet.createdAt,
      id: 'as_dashboard_control_1',
      message: null,
      status: 'busy',
      threadId: sourceTurn.threadId,
      updatedAt: sourceReview.changeSet.createdAt,
      workspaceId: sourceTurn.workspaceId,
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...createOpenShellWorkerControlPackage(store, sourceTurn.id),
      snapshotId: `aepsnap_test_${sourceReview.changeSet.materializationRecordId}`,
    });
    store.createArtifact({
      id: sourceReview.artifactId,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      kind: 'diff',
      title: 'Workspace sync review',
      status: 'ready',
      summary: sourceReview.review.riskSummary,
      version: 1,
      content: { format: 'text', body: sourceReview.patchPayload?.text ?? '' },
      createdAt: sourceReview.review.createdAt,
      updatedAt: sourceReview.review.updatedAt,
    });
    try {
      recordAgentEnvironmentPackageSnapshot(sourceDb, {
        createdAt: sourceReview.changeSet.createdAt,
        environmentPackage,
      });
      recordTestWorkspaceReviewMaterialization(sourceDb, sourceReview);
      recordWorkspaceSyncReview(sourceDb, { item: sourceReview });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/staged-workspace-reviews.jsonl');
    expect(exported.checkedFiles).toContain('records/workspace-change-sets.jsonl');
    expect(exported.checkedFiles).toContain('records/workspace-input-snapshots.jsonl');
    expect(exported.checkedFiles).toContain('records/workspace-materialization-records.jsonl');
    expect(exported.checkedFiles).toContain('records/backend-workspace-handles.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d762',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedArtifact = store.listArtifacts(body.importedWorkspaceId)[0];
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(listWorkspaceInputSnapshots(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'wis_route_1',
          workspaceId: body.importedWorkspaceId,
          resourceId: 'repo_default',
        }),
      ]);
      expect(listWorkspaceMaterializationRecords(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'wmr_route_1',
          workspaceId: body.importedWorkspaceId,
          inputSnapshotId: 'wis_route_1',
          materializedRootRef: `workspace://${body.importedWorkspaceId}/repo_default`,
        }),
      ]);
      expect(listBackendWorkspaceHandles(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'bwh_wmr_route_1',
          workspaceId: body.importedWorkspaceId,
          materializationRecordId: 'wmr_route_1',
          transportRefs: [
            {
              kind: 'materialized-root',
              ref: `workspace://${body.importedWorkspaceId}/repo_default`,
            },
          ],
        }),
      ]);
      expect(listWorkspaceChangeSets(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          id: 'wcs_route_1',
          workspaceId: body.importedWorkspaceId,
          materializationRecordId: 'wmr_route_1',
        }),
      ]);
      expect(listWorkspaceSyncReviews(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          artifactId: importedArtifact?.id,
          changeSet: expect.objectContaining({
            id: 'wcs_route_1',
            workspaceId: body.importedWorkspaceId,
          }),
          patchPayload: expect.objectContaining({ digest: sourceReview.patchPayload?.digest }),
          review: expect.objectContaining({
            id: 'swr_route_1',
            changeSetId: 'wcs_route_1',
            workspaceId: body.importedWorkspaceId,
          }),
        }),
      ]);
      const stagedAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action = ?')
        .all('workspace.review.stage') as Array<Record<string, unknown>>;
      expect(stagedAuditRows).toHaveLength(1);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace apply results as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-apply-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const sourceReview = workspaceSyncReviewRouteItem();
    const sourceTurn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Produce workspace apply result',
      null,
      {
        turnId: 'turn_route_1',
      }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: sourceReview.changeSet.createdAt,
      id: 'as_dashboard_control_1',
      message: null,
      status: 'busy',
      threadId: sourceTurn.threadId,
      updatedAt: sourceReview.changeSet.createdAt,
      workspaceId: sourceTurn.workspaceId,
    });
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...createOpenShellWorkerControlPackage(store, sourceTurn.id),
      snapshotId: `aepsnap_test_${sourceReview.changeSet.materializationRecordId}`,
    });
    store.createArtifact({
      id: sourceReview.artifactId,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      kind: 'diff',
      title: 'Workspace apply result',
      status: 'ready',
      summary: sourceReview.review.riskSummary,
      version: 1,
      content: { format: 'text', body: sourceReview.patchPayload?.text ?? '' },
      createdAt: sourceReview.review.createdAt,
      updatedAt: sourceReview.review.updatedAt,
    });
    try {
      recordAgentEnvironmentPackageSnapshot(sourceDb, {
        createdAt: sourceReview.changeSet.createdAt,
        environmentPackage,
      });
      recordTestWorkspaceReviewMaterialization(sourceDb, sourceReview);
      recordWorkspaceSyncReview(sourceDb, { item: sourceReview });
      recordWorkspaceApplyResult(sourceDb, {
        requestId: '00000000-0000-4000-8000-00000000d771',
        result: {
          appliedAt: '2026-07-06T00:01:00.000Z',
          appliedPaths: ['docs/sync.md'],
          changeSetId: 'wcs_route_1',
          commitIds: ['commit_route_1'],
          conflictRecords: [],
          id: 'war_route_1',
          reviewId: 'swr_route_1',
          skippedPaths: [],
          status: 'applied',
          verification: [],
          workspaceId: 'ws_demo',
        },
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/workspace-apply-results.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d772',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(listWorkspaceApplyResults(importedDb, body.importedWorkspaceId)).toEqual([
        expect.objectContaining({
          appliedPaths: ['docs/sync.md'],
          changeSetId: 'wcs_route_1',
          commitIds: ['commit_route_1'],
          id: 'war_route_1',
          reviewId: 'swr_route_1',
          status: 'applied',
          workspaceId: body.importedWorkspaceId,
        }),
      ]);
      const applyAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action = ?')
        .all('workspace.apply.finish') as Array<Record<string, unknown>>;
      expect(applyAuditRows).toHaveLength(1);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports workspace permission decisions as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-permission-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createTurn('ws_demo', 'th_demo', 'Record permission decision', null, {
      turnId: 'turn_demo',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordProductPermissionDecision({
        action: 'runtime.launch',
        contextSummary: {
          requestId: '00000000-0000-4000-8000-00000000d781',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          workspaceId: 'ws_demo',
        },
        decisionId: 'pd_workspace_import_1',
        enforcementPoint: 'runtime.worker_turn_loop.start',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-worker-policy:v1',
        policySnapshotId: 'worker_turn_launch_policy',
        reasonCode: 'worker_turn_start_allowed',
        resourceSummary: { kind: 'worker-turn', turnId: 'turn_demo' },
        result: 'allow',
        subjectSummary: { id: 'worker-coordinator', kind: 'nanocore' },
        workspaceDb: sourceDb,
        workspaceId: 'ws_demo',
        now: new Date('2026-07-06T00:02:00.000Z'),
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/permission-decisions.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d782',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      const decision = importedDb.sqlite
        .prepare(
          `SELECT
            decision_id,
            owner_scope,
            workspace_id,
            action,
            result,
            reason_code,
            audit_event_id
          FROM permission_decisions
          WHERE decision_id = ?`
        )
        .get('pd_workspace_import_1') as Record<string, unknown> | undefined;

      expect(decision).toEqual({
        action: 'runtime.launch',
        audit_event_id: expect.stringMatching(/^aud_/),
        decision_id: 'pd_workspace_import_1',
        owner_scope: 'workspace',
        reason_code: 'worker_turn_start_allowed',
        result: 'allow',
        workspace_id: body.importedWorkspaceId,
      });
      const permissionAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action = ?')
        .all('permission.decision') as Array<Record<string, unknown>>;
      expect(permissionAuditRows).toHaveLength(1);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('lists workspace-filtered scheduler admissions through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-list-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Scheduler admission read route');
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_read_route_1',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_read_1',
      turnInput: 'First queued turn with /Users/private local path hidden from response.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
      now: () => '2026-07-07T00:00:00.000Z',
    });
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_read_route_2',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_read_2',
      turnInput: 'Second queued turn.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'automation',
      requiredPoolConstraints: ['openshell.local'],
      now: () => '2026-07-07T00:00:01.000Z',
    });
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_read_route_denied',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_read_denied',
      turnInput: 'Denied turn.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
      now: () => '2026-07-07T00:00:02.000Z',
    });
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_read_route_denied',
      denialReason: 'no-healthy-target',
    });
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_other_workspace',
      workspaceId: 'ws_other',
      threadId: 'th_other',
      turnId: 'turn_other',
      turnInput: 'Other workspace turn.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/workspaces/ws_demo/scheduler/admissions');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListSchedulerAdmissionsResponseSchema.parse(await res.json());
    expect(payload.items).toMatchObject([
      {
        queueEntryId: 'queue_read_route_1',
        workspaceId: 'ws_demo',
        status: 'queued',
        denialReason: null,
        queuePosition: 1,
      },
      {
        queueEntryId: 'queue_read_route_2',
        workspaceId: 'ws_demo',
        status: 'queued',
        denialReason: null,
        queuePosition: 3,
      },
      {
        queueEntryId: 'queue_read_route_denied',
        workspaceId: 'ws_demo',
        status: 'denied',
        denialReason: 'no-healthy-target',
        queuePosition: null,
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain('/Users/private');
    expect(JSON.stringify(payload)).not.toContain('queue_other_workspace');
    coreDb.sqlite.close();
  });

  it('lists workspace audit events through App API without raw payload fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-audit-events-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordWorkspaceAuditEvent({
        auditEventId: 'aud_route_1',
        workspaceDb,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        category: 'system',
        action: 'goal.create',
        resource: 'goal:goal_route_1',
        outcome: 'succeeded',
        summary: 'Goal created.',
        requestId: '00000000-0000-4000-8000-00000000a771',
        now: new Date('2026-07-07T00:00:00.000Z'),
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/workspaces/ws_demo/audit/events');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListWorkspaceAuditEventsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      workspaceId: 'ws_demo',
      auditEvents: [
        {
          action: 'goal.create',
          id: 'aud_route_1',
          resource: 'goal:goal_route_1',
          workspaceId: 'ws_demo',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('user_secret');
    coreDb.sqlite.close();
  });

  it('lists server audit events through App API without raw payload fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-audit-events-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    recordServerAuditEvent({
      auditEventId: 'aud_server_route_1',
      coreDb,
      category: 'system',
      action: 'server.config.update',
      resource: 'server:runtime-config',
      outcome: 'succeeded',
      summary: 'Runtime config updated.',
      requestId: '00000000-0000-4000-8000-00000000a772',
      now: new Date('2026-07-07T00:00:30.000Z'),
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/audit/events');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListServerAuditEventsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      auditEvents: [
        {
          action: 'server.config.update',
          id: 'aud_server_route_1',
          resource: 'server:runtime-config',
          workspaceId: null,
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('user_secret');
    coreDb.sqlite.close();
  });

  it('keeps workspace evidence bundle access read-only for automatically produced bundles', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-evidence-bundle-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const item = workspaceSyncReviewRouteItem();

    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
    } finally {
      workspaceDb.sqlite.close();
    }

    const createRes = await app.request('/api/app/workspaces/ws_demo/evidence-bundles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const listRes = await app.request('/api/app/workspaces/ws_demo/evidence-bundles');

    expect(createRes.status).toBe(404);
    expect(listRes.status, await listRes.clone().text()).toBe(200);
    expect(ListWorkspaceEvidenceBundlesResponseSchema.parse(await listRes.json())).toMatchObject({
      workspaceId: 'ws_demo',
      evidenceBundles: [
        {
          id: 'evb_workspace_materialization_wmr_route_1',
          sourceKind: 'workspace-materialization',
          importStatus: 'promoted',
        },
        {
          id: 'evb_workspace_review_swr_route_1',
          sourceKind: 'workspace-sync-review',
          importStatus: 'promoted',
        },
      ],
    });
    coreDb.sqlite.close();
  });

  it('lists workspace runtime evidence through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-runtime-evidence-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_runtime',
        turnId: 'turn_runtime',
        requestId: 'req_turn_runtime',
        requestInputHash: 'sha256:turn_runtime',
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: 'session_runtime',
        now: () => '2026-07-07T00:04:00.000Z',
      });
      updateWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_runtime',
        turnId: 'turn_runtime',
        stage: 'completed',
        stopReason: 'completed',
        now: () => '2026-07-07T00:05:00.000Z',
      });
      const app = createApp({ coreDb, dataRoot, store });

      const res = await app.request('/api/app/workspaces/ws_demo/runtime-evidence');

      expect(res.status, await res.clone().text()).toBe(200);
      const body = ListWorkspaceRuntimeEvidenceResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        workspaceId: 'ws_demo',
        runtimeEvidence: [
          {
            workspaceId: 'ws_demo',
            threadId: 'th_runtime',
            turnId: 'turn_runtime',
            agentSessionId: 'session_runtime',
            phase: 'checkpoint',
            outcome: 'succeeded',
            stopReason: 'completed',
            requiredFeatures: ['runtime.evidence.v1'],
          },
        ],
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('lists workspace permission decisions through App API without raw payload fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-permission-decisions-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      recordProductPermissionDecision({
        action: 'runtime.launch',
        contextSummary: {
          requestId: '00000000-0000-4000-8000-00000000d791',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          workspaceId: 'ws_demo',
        },
        decisionId: 'pd_route_1',
        enforcementPoint: 'runtime.worker_turn_loop.start',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-worker-policy:v1',
        policySnapshotId: 'worker_turn_launch_policy',
        reasonCode: 'higher_authority_required',
        resourceSummary: { kind: 'worker-turn', turnId: 'turn_demo' },
        result: 'require_escalation',
        subjectSummary: { id: 'worker-coordinator', kind: 'nanocore' },
        workspaceDb,
        workspaceId: 'ws_demo',
        now: new Date('2026-07-07T00:01:00.000Z'),
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/workspaces/ws_demo/permission-decisions');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListWorkspacePermissionDecisionsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      workspaceId: 'ws_demo',
      permissionDecisions: [
        {
          action: 'runtime.launch',
          decisionId: 'pd_route_1',
          result: 'require_escalation',
          workspaceId: 'ws_demo',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('user_secret');
    coreDb.sqlite.close();
  });

  it('lists server permission decisions through App API without raw payload fields', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-permission-decisions-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    recordProductPermissionDecision({
      action: 'llm.gateway.chat_completions',
      contextSummary: { route: '/v1/chat/completions' },
      coreDb,
      decisionId: 'pd_server_route_1',
      enforcementPoint: 'llm.gateway.policy',
      ownerScope: 'server',
      policyEngineVersion: 'nanocore-gateway-policy:v1',
      policySnapshotId: 'runtime_config_gateway_policy',
      reasonCode: 'policy_context_missing',
      resourceSummary: { kind: 'llm-provider', providerId: 'openrouter' },
      result: 'defer',
      subjectSummary: { id: 'openai-compatible', kind: 'gateway-client' },
      now: new Date('2026-07-07T00:02:00.000Z'),
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/permission-decisions');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListServerPermissionDecisionsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      permissionDecisions: [
        {
          action: 'llm.gateway.chat_completions',
          decisionId: 'pd_server_route_1',
          result: 'defer',
          workspaceId: null,
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('user_secret');
    coreDb.sqlite.close();
  });

  it('lists workspace vault use records through App API without secret material', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-vault-use-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createVaultUseRecord(workspaceDb, {
        useId: 'use_route_1',
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        vaultReferenceId: 'vault_github',
        materialVersion: 1,
        backendKind: 'encrypted-file',
        resolvingPath: 'grant',
        grantId: 'grant_github',
        agentSessionId: 'as_1',
        outcome: 'succeeded',
        auditEventId: 'aud_vault_use_route_1',
        usedAt: '2026-07-07T00:00:00.000Z',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/workspaces/ws_demo/vault/use-records');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListWorkspaceVaultUseRecordsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      workspaceId: 'ws_demo',
      vaultUseRecords: [
        {
          useId: 'use_route_1',
          vaultReferenceId: 'vault_github',
          grantId: 'grant_github',
          outcome: 'succeeded',
          workspaceId: 'ws_demo',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('ghp_secret');
    coreDb.sqlite.close();
  });

  it('lists server vault use records through App API without secret material', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-vault-use-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    createVaultUseRecord(coreDb, {
      useId: 'use_server_route_1',
      ownerScope: 'server',
      workspaceId: null,
      vaultReferenceId: 'vault_openrouter',
      materialVersion: 1,
      backendKind: 'encrypted-file',
      resolvingPath: 'provider',
      outcome: 'failed',
      failureCode: 'backend-locked',
      auditEventId: 'aud_server_vault_use_route_1',
      usedAt: '2026-07-07T00:00:00.000Z',
    });
    const app = createApp({ coreDb, dataRoot, store });

    const res = await app.request('/api/app/vault/use-records');

    expect(res.status, await res.clone().text()).toBe(200);
    const payload = ListServerVaultUseRecordsResponseSchema.parse(await res.json());
    expect(payload).toMatchObject({
      vaultUseRecords: [
        {
          useId: 'use_server_route_1',
          ownerScope: 'server',
          workspaceId: null,
          vaultReferenceId: 'vault_openrouter',
          outcome: 'failed',
          failureCode: 'backend-locked',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('sk-provider-secret');
    coreDb.sqlite.close();
  });

  it('retries denied scheduler admissions through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-retry-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Scheduler admission retry route');
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_retry_route',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_retry',
      turnInput: 'Retry scheduler admission.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    denySchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_retry_route',
      denialReason: 'no-healthy-target',
    });
    const app = createApp({ coreDb, dataRoot, store });

    const retryRes = await app.request(
      '/api/app/workspaces/ws_demo/scheduler/admissions/queue_retry_route/retry',
      { method: 'POST' }
    );

    expect(retryRes.status, await retryRes.clone().text()).toBe(200);
    expect(RetrySchedulerAdmissionResponseSchema.parse(await retryRes.json())).toEqual({
      retried: true,
    });
    expect(listQueuedSchedulerAdmissionEntries(coreDb).map((entry) => entry.queueEntryId)).toEqual([
      'queue_retry_route',
    ]);
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, outcome, resource, request_id, thread_id, turn_id, summary
            FROM audit_events
            WHERE action = 'scheduler.admission.retry'`
          )
          .all()
      ).toEqual([
        {
          action: 'scheduler.admission.retry',
          outcome: 'succeeded',
          resource: 'scheduler-admission:queue_retry_route',
          request_id: null,
          thread_id: thread.id,
          turn_id: 'turn_scheduler_retry',
          summary: 'Scheduler admission retried.',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('cancels scheduler admissions through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-scheduler-admission-cancel-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Scheduler admission cancel route');
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue_cancel_route',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: 'turn_scheduler_cancel',
      turnInput: 'Cancel scheduler admission.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    const app = createApp({ coreDb, dataRoot, store });

    const cancelRes = await app.request(
      '/api/app/workspaces/ws_demo/scheduler/admissions/queue_cancel_route/cancel',
      { method: 'POST' }
    );

    expect(cancelRes.status, await cancelRes.clone().text()).toBe(200);
    expect(CancelSchedulerAdmissionResponseSchema.parse(await cancelRes.json())).toEqual({
      cancelled: true,
    });
    expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual([]);
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, outcome, resource, request_id, thread_id, turn_id, summary
            FROM audit_events
            WHERE action = 'scheduler.admission.cancel'`
          )
          .all()
      ).toEqual([
        {
          action: 'scheduler.admission.cancel',
          outcome: 'cancelled',
          resource: 'scheduler-admission:queue_cancel_route',
          request_id: null,
          thread_id: thread.id,
          turn_id: 'turn_scheduler_cancel',
          summary: 'Scheduler admission cancelled.',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('does not expose generic pending-input recovery through App API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-user-turn-route-absence-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const app = createApp({ coreDb, dataRoot, store: createDemoStore({ dataRoot }) });

    try {
      const routes = [
        ['POST', '/api/app/workspaces/ws_demo/threads/th_demo/recovery/interrupted-worker'],
        ['GET', '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns'],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns/req_demo/edit',
        ],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns/req_demo/interrupt',
        ],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns/req_demo/cancel',
        ],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/pending-user-turns/req_demo/follow-up',
        ],
        [
          'POST',
          '/api/app/workspaces/ws_demo/threads/th_demo/recovery/interrupted-worker/turn_demo/terminal',
        ],
      ];

      for (const [method, route] of routes) {
        const response = await app.request(route!, { method });
        expect(response.status, route).toBe(404);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('restarts runtime config stale sessions by retiring the old session record', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Retire stale session');
    const session = store.createAgentSession({
      agentId: 'agent_codex_host',
      configVersion: 1,
      createdAt: '2026-07-07T00:00:00.000Z',
      id: 'as_stale_route',
      message: null,
      status: 'busy',
      threadId: thread.id,
      updatedAt: '2026-07-07T00:00:00.000Z',
      workspaceId: 'ws_demo',
      workspaceRoots: [],
    });
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-config-stale-session-'));
    const runtimeConfigManager = createRuntimeConfigManager({
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot, version: 2 }),
    });
    const app = createApp({ runtimeConfigManager, store });

    const res = await app.request(
      `/api/app/workspaces/ws_demo/runtime-config/stale-sessions/${session.id}/restart`,
      { method: 'POST' }
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(RestartRuntimeConfigStaleSessionResponseSchema.parse(await res.json())).toMatchObject({
      restarted: true,
      session: {
        configVersion: 2,
        id: session.id,
        stale: false,
        status: 'interrupted',
      },
    });
    expect(store.getAgentSession(session.id)).toMatchObject({
      configVersion: 2,
      status: 'interrupted',
    });
  });

  it('releases one authoritatively interrupted goal task and replays its command', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-interrupted-worker-retry-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Interrupted worker retry route');
    const turn = store.createTurn('ws_demo', thread.id, 'Interrupted worker');
    const agentSessionId = 'as_interrupted_retry';
    const completedAt = '2026-07-17T05:00:00.000Z';
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: turn.startedAt ?? completedAt,
      id: agentSessionId,
      message: 'Worker execution was interrupted during NanoCore restart recovery.',
      status: 'interrupted',
      threadId: thread.id,
      updatedAt: completedAt,
      workspaceId: 'ws_demo',
    });
    const interruptedTurn = store.updateTurn(turn.id, {
      agentSessionId,
      completedAt,
      error: {
        code: 'worker_governance_restart_recovery',
        message: 'Worker execution was interrupted during NanoCore restart recovery.',
      },
      status: 'interrupted',
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createGoalRecord(workspaceDb, {
        goalId: 'goal_retry',
        objective: 'Recover interrupted work.',
        status: 'running',
        threadId: thread.id,
        title: 'Recover work',
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
      });
      updateGoalStatus(workspaceDb, {
        currentTaskId: 'task_retry',
        goalId: 'goal_retry',
        planItemId: 'it_goal_plan_retry',
        status: 'running',
        threadId: thread.id,
        workspaceId: 'ws_demo',
      });
      createGoalTask(workspaceDb, {
        ...GOAL_TASK_RECORD_FIXTURE,
        acceptanceCriteria: ['Retry is queued.'],
        contextBudgetTokens: 1024,
        dependsOnTaskIds: [],
        goalId: 'goal_retry',
        planItemId: 'it_goal_plan_retry',
        objective: 'Retry the interrupted task.',
        orderIndex: 0,
        status: 'running',
        taskId: 'task_retry',
        threadId: thread.id,
        title: 'Retry task',
        workspaceId: 'ws_demo',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        contextDigest: 'sha256:retry-context',
        diagnosticsSummary: 'Worker stopped before terminal save.',
        goalId: 'goal_retry',
        iteration: 1,
        stage: 'running_worker',
        taskId: 'task_retry',
        threadId: thread.id,
        turnId: turn.id,
        requestId: `req_${turn.id}`,
        requestInputHash: `sha256:${turn.id}`,
        workerSessionId: agentSessionId,
        workspaceId: 'ws_demo',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    recordWorkerRetryLease(coreDb, {
      agentSessionId,
      recoveryState: null,
      releaseReason: 'scheduler-restart-backend-cleanup',
      status: 'released',
      threadId: thread.id,
      turnId: turn.id,
    });
    const app = createApp({ coreDb, dataRoot, store });
    const recoveryBefore = await app.request('/api/app/recovery/interrupted-workers');
    expect(recoveryBefore.status, await recoveryBefore.clone().text()).toBe(200);
    await expect(recoveryBefore.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          checkpointId: `ws_demo:${thread.id}:${turn.id}`,
          choices: expect.arrayContaining([expect.objectContaining({ kind: 'retry' })]),
        }),
      ],
    });

    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'req_worker_recovery_retry' }),
    } as const;

    const retryRes = await app.request(
      `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/interrupted-worker/${turn.id}/retry`,
      request
    );

    expect(retryRes.status, await retryRes.clone().text()).toBe(200);
    const response = RetryInterruptedWorkerCheckpointResponseSchema.parse(await retryRes.json());
    expect(response).toEqual({
      outcome: 'released_for_retry',
      turnId: turn.id,
    });
    expect(store.getTurnById(turn.id)).toEqual(interruptedTurn);

    const reopenedDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      expect(getWorkerCheckpoint(reopenedDb, 'ws_demo', thread.id, turn.id)).toBeNull();
      expect(
        listGoalTasks(reopenedDb, {
          goalId: 'goal_retry',
          threadId: thread.id,
          workspaceId: 'ws_demo',
        })[0]?.status
      ).toBe('ready');
      expect(getGoalRecord(reopenedDb, 'ws_demo', thread.id, 'goal_retry')).toMatchObject({
        currentTaskId: null,
        status: 'running',
      });
      expect(
        store.getCommandRequest(
          'worker.recovery.retry',
          'req_worker_recovery_retry',
          { workspaceId: 'ws_demo', threadId: thread.id, turnId: turn.id },
          reopenedDb
        )
      ).toMatchObject({
        response: { id: turn.id, kind: 'turn' },
      });
    } finally {
      reopenedDb.sqlite.close();
    }

    const replay = await app.request(
      `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/interrupted-worker/${turn.id}/retry`,
      request
    );
    expect(replay.status, await replay.clone().text()).toBe(200);
    await expect(replay.json()).resolves.toEqual(response);
    expect(store.getTurnById(turn.id)).toEqual(interruptedTurn);
    expect(requireSchedulerSessionLease(coreDb, `lease_${turn.id}`)).toMatchObject({
      recoveryState: null,
      releaseReason: 'scheduler-restart-backend-cleanup',
      status: 'released',
    });
    coreDb.sqlite.close();
  });

  it('rejects interrupted-worker retry while exact reconnect remains pending', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-reconnect-pending-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Reconnect pending retry route');
    const turn = store.createTurn('ws_demo', thread.id, 'Reconnect original worker');
    const agentSessionId = 'as_reconnect_pending';
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: turn.startedAt ?? '2026-07-17T05:00:00.000Z',
      id: agentSessionId,
      message: null,
      status: 'busy',
      threadId: thread.id,
      updatedAt: '2026-07-17T05:00:00.000Z',
      workspaceId: 'ws_demo',
    });
    store.updateTurn(turn.id, { agentSessionId });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkerCheckpoint(workspaceDb, {
        contextDigest: 'sha256:reconnect-pending',
        diagnosticsSummary: 'Original worker may reconnect.',
        iteration: 1,
        stage: 'running_worker',
        threadId: thread.id,
        turnId: turn.id,
        requestId: `req_${turn.id}`,
        requestInputHash: `sha256:${turn.id}`,
        workerSessionId: agentSessionId,
        workspaceId: 'ws_demo',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    recordWorkerRetryLease(coreDb, {
      agentSessionId,
      recoveryState: 'awaiting-reconnect',
      releaseReason: null,
      status: 'active',
      threadId: thread.id,
      turnId: turn.id,
    });
    const turnBefore = store.getTurnById(turn.id);
    const sessionBefore = store.getAgentSession(agentSessionId);
    const leaseBefore = requireSchedulerSessionLease(coreDb, `lease_${turn.id}`);
    const checkpointDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const checkpointBefore = getWorkerCheckpoint(checkpointDb, 'ws_demo', thread.id, turn.id);
    checkpointDb.sqlite.close();
    const app = createApp({
      coreDb,
      dataRoot,
      store,
      workerControlGateway: new WorkerControlGateway(),
    });

    const list = await app.request('/api/app/recovery/interrupted-workers');
    await expect(list.json()).resolves.toEqual({ items: [] });
    const retry = await app.request(
      `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/interrupted-worker/${turn.id}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req_reconnect_pending_retry' }),
      }
    );

    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({ code: 'worker_reconnect_pending' });
    expect(store.getTurnById(turn.id)).toEqual(turnBefore);
    expect(store.getAgentSession(agentSessionId)).toEqual(sessionBefore);
    expect(requireSchedulerSessionLease(coreDb, `lease_${turn.id}`)).toEqual(leaseBefore);
    const reopenedDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    expect(getWorkerCheckpoint(reopenedDb, 'ws_demo', thread.id, turn.id)).toEqual(
      checkpointBefore
    );
    reopenedDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('exports and imports worker checkpoints as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-checkpoint-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    store.createTurn('ws_demo', 'th_demo', 'Checkpoint worker turn', null, {
      turnId: 'tu_checkpoint',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkerCheckpoint(sourceDb, {
        contextDigest: 'sha256:checkpoint-context',
        diagnosticsSummary: 'checkpoint diagnostics',
        iteration: 3,
        now: () => '2026-07-06T00:04:00.000Z',
        requestId: 'req_checkpoint',
        requestInputHash: 'sha256:checkpoint-request',
        stage: 'running_worker',
        threadId: 'th_demo',
        turnId: 'tu_checkpoint',
        workerSessionId: 'as_checkpoint',
        workspaceId: 'ws_demo',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/worker-turn-checkpoints.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d802',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedThreadId = `th_imported_${body.importedWorkspaceId}_1`;
    const importedTurnId = `tu_imported_${body.importedWorkspaceId}_1`;
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(
        getWorkerCheckpoint(importedDb, body.importedWorkspaceId, importedThreadId, importedTurnId)
      ).toEqual(
        expect.objectContaining({
          checkpointId: `${body.importedWorkspaceId}:${importedThreadId}:${importedTurnId}`,
          contextDigest: 'sha256:checkpoint-context',
          goalId: null,
          iteration: 3,
          requestId: 'req_checkpoint',
          requestInputHash: 'sha256:checkpoint-request',
          stage: 'running_worker',
          taskId: null,
          threadId: importedThreadId,
          turnId: importedTurnId,
          workerSessionId: 'as_checkpoint',
          workspaceId: body.importedWorkspaceId,
        })
      );
      const checkpointAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action = ?')
        .all('worker.checkpoint.terminal') as Array<Record<string, unknown>>;
      expect(checkpointAuditRows).toHaveLength(0);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports Goal Mode goal and task rows as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-goal-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourcePlan = GoalPlanOutputSchema.parse({
      schemaVersion: 1,
      goalSummary: 'Import this goal.',
      assumptions: [],
      tasks: [
        {
          taskId: 'task_import_1',
          title: 'Import task',
          objective: 'Import this task.',
          acceptanceCriteria: ['Task imported.'],
          contextBudgetTokens: 12000,
          resources: [],
          expectedArtifacts: [],
          verificationChecks: [{ kind: 'manual', description: 'Confirm imported task.' }],
          reviewPolicy: {
            required: true,
            reviewers: ['human'],
            instructions: 'Review the imported task.',
          },
          dependsOnTaskIds: [],
          escalationConditions: [],
        },
      ],
      risks: [],
      questions: [],
      verificationApproach: 'Confirm the imported task record.',
    });
    const sourceTurn = store.createTurn('ws_demo', 'th_demo', 'Create portable goal', null, {
      turnId: 'turn_goal_import_1',
    });
    store.createItem({
      id: 'item_goal_import_1',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      type: 'user-message',
      status: 'completed',
      text: 'Create an importable goal',
      createdAt: '2026-07-06T00:04:59.000Z',
      completedAt: '2026-07-06T00:04:59.000Z',
    });
    store.createItem({
      id: 'item_goal_plan_import_1',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      type: 'plan',
      status: 'completed',
      title: 'Import goal',
      summary: sourcePlan.goalSummary,
      steps: sourcePlan.tasks.map((task) => ({
        id: task.taskId,
        title: task.title,
        status: 'pending',
      })),
      createdAt: '2026-07-06T00:05:00.000Z',
      completedAt: '2026-07-06T00:05:00.000Z',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createGoalRecord(sourceDb, {
        createdByItemId: 'item_goal_import_1',
        goalId: 'goal_import_1',
        objective: 'Import this goal.',
        status: 'running',
        threadId: 'th_demo',
        title: 'Import goal',
        workspaceExists: () => true,
        workspaceId: 'ws_demo',
        now: () => '2026-07-06T00:05:00.000Z',
      });
      createGoalPlanRecord(sourceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_import_1',
        planItemId: 'item_goal_plan_import_1',
        plan: sourcePlan,
        createdByRequestId: 'goal-plan-import-1',
        now: () => '2026-07-06T00:05:00.000Z',
      });
      const sourcePlanTask = sourcePlan.tasks[0]!;
      createGoalTask(sourceDb, {
        ...sourcePlanTask,
        goalId: 'goal_import_1',
        planItemId: 'item_goal_plan_import_1',
        orderIndex: 0,
        status: 'ready',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
        now: () => '2026-07-06T00:05:01.000Z',
      });
      updateGoalStatus(sourceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_import_1',
        status: 'running',
        planItemId: 'item_goal_plan_import_1',
        now: () => '2026-07-06T00:05:01.000Z',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/goal-records.jsonl');
    expect(exported.checkedFiles).toContain('records/goal-tasks.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d812',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedThreadId = `th_imported_${body.importedWorkspaceId}_1`;
    const importedItemId = `it_imported_${body.importedWorkspaceId}_1`;
    const importedGoalId = `goal_imported_${body.importedWorkspaceId}_1`;
    const importedTaskId = `task_imported_${body.importedWorkspaceId}_1`;
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(
        listGoalRecordsForThread(importedDb, {
          workspaceId: body.importedWorkspaceId,
          threadId: importedThreadId,
        })
      ).toEqual([
        expect.objectContaining({
          createdByItemId: importedItemId,
          goalId: importedGoalId,
          objective: 'Import this goal.',
          status: 'running',
          title: 'Import goal',
          workspaceId: body.importedWorkspaceId,
        }),
      ]);
      expect(
        listGoalTasks(importedDb, {
          workspaceId: body.importedWorkspaceId,
          threadId: importedThreadId,
          goalId: importedGoalId,
        })
      ).toEqual([
        expect.objectContaining({
          acceptanceCriteria: ['Task imported.'],
          goalId: importedGoalId,
          status: 'ready',
          taskId: importedTaskId,
          verificationChecks: [{ kind: 'manual', description: 'Confirm imported task.' }],
          workspaceId: body.importedWorkspaceId,
        }),
      ]);
      const goalAuditRows = importedDb.sqlite
        .prepare('SELECT action FROM audit_events WHERE action IN (?, ?) ORDER BY action')
        .all('goal.create', 'goal.task.create') as Array<Record<string, unknown>>;
      expect(goalAuditRows).toEqual([{ action: 'goal.create' }, { action: 'goal.task.create' }]);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports Goal Mode review and verification rows as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-goal-evidence-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceEvidencePlan = GoalPlanOutputSchema.parse({
      schemaVersion: 1,
      goalSummary: 'Import goal evidence.',
      assumptions: [],
      tasks: [
        {
          taskId: 'task_evidence_1',
          title: 'Import evidence task',
          objective: 'Import goal evidence task.',
          acceptanceCriteria: ['Evidence imported.'],
          contextBudgetTokens: 12000,
          resources: [],
          expectedArtifacts: [{ kind: 'artifact', description: 'Portable goal evidence.' }],
          verificationChecks: [{ kind: 'test', description: 'Run the evidence test.' }],
          reviewPolicy: {
            required: true,
            reviewers: ['human'],
            instructions: 'Review the imported evidence.',
          },
          dependsOnTaskIds: [],
          escalationConditions: [],
        },
      ],
      risks: [],
      questions: [],
      verificationApproach: 'Import and inspect the evidence records.',
    });
    const sourceTurn = store.createTurn('ws_demo', 'th_demo', 'Collect goal evidence', null, {
      turnId: 'turn_evidence_1',
    });
    store.createItem({
      id: 'item_evidence_1',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Evidence collected',
      createdAt: '2026-07-06T00:05:59.000Z',
      completedAt: '2026-07-06T00:05:59.000Z',
    });
    store.createItem({
      id: 'item_goal_plan_evidence_1',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      type: 'plan',
      status: 'completed',
      title: 'Import evidence goal',
      summary: sourceEvidencePlan.goalSummary,
      steps: sourceEvidencePlan.tasks.map((task) => ({
        id: task.taskId,
        title: task.title,
        status: 'pending',
      })),
      createdAt: '2026-07-06T00:06:00.000Z',
      completedAt: '2026-07-06T00:06:00.000Z',
    });
    store.createArtifact({
      id: 'artifact_evidence_1',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: sourceTurn.id,
      kind: 'summary',
      title: 'Goal evidence',
      status: 'ready',
      summary: 'Portable goal evidence.',
      version: 1,
      content: { format: 'text', body: 'Evidence body' },
      createdAt: '2026-07-06T00:05:59.000Z',
      updatedAt: '2026-07-06T00:05:59.000Z',
    });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const sourceGoal = createGoalRecord(sourceDb, {
        goalId: 'goal_evidence_1',
        objective: 'Import goal evidence.',
        status: 'reviewing',
        currentTaskId: 'task_evidence_1',
        threadId: 'th_demo',
        title: 'Import evidence goal',
        workspaceExists: () => true,
        workspaceId: 'ws_demo',
        now: () => '2026-07-06T00:06:00.000Z',
      });
      createGoalPlanRecord(sourceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_evidence_1',
        planItemId: 'item_goal_plan_evidence_1',
        plan: sourceEvidencePlan,
        createdByRequestId: 'goal-plan-evidence-1',
        now: () => '2026-07-06T00:06:00.000Z',
      });
      const sourceEvidenceTask = sourceEvidencePlan.tasks[0]!;
      const sourceTask = createGoalTask(sourceDb, {
        ...sourceEvidenceTask,
        goalId: 'goal_evidence_1',
        planItemId: 'item_goal_plan_evidence_1',
        orderIndex: 0,
        status: 'reviewing',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
        now: () => '2026-07-06T00:06:01.000Z',
      });
      updateGoalStatus(sourceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_evidence_1',
        status: 'reviewing',
        planItemId: 'item_goal_plan_evidence_1',
        currentTaskId: 'task_evidence_1',
        now: () => '2026-07-06T00:06:01.000Z',
      });
      createGoalReviewRecord(sourceDb, {
        artifactIds: ['artifact_evidence_1'],
        goalId: 'goal_evidence_1',
        itemIds: ['item_evidence_1'],
        prompt: 'Review the imported Goal evidence.',
        createdByRequestId: 'goal-step-evidence-1',
        reviewId: 'gr_evidence_1',
        taskId: 'task_evidence_1',
        threadId: 'th_demo',
        turnId: 'turn_evidence_1',
        verificationEvidence: [{ kind: 'manual', summary: 'Looks good.' }],
        workspaceId: 'ws_demo',
        now: () => '2026-07-06T00:06:02.000Z',
      });
      resolveGoalReviewRecord(sourceDb, {
        goalId: 'goal_evidence_1',
        requestId: 'goal-review-evidence-resolution-1',
        actorId: 'user_demo',
        verdict: 'accept',
        resolutionSnapshot: {
          outcome: 'complete_goal',
          task: { taskId: sourceTask.taskId, status: 'completed' },
          goal: {
            goalId: sourceGoal.goalId,
            status: 'completed',
            currentTaskId: null,
            terminalStopReason: 'completed',
          },
          nextReadyTaskId: null,
        },
        reviewId: 'gr_evidence_1',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
        now: () => '2026-07-06T00:06:02.500Z',
      });
      createGoalVerificationRecord(sourceDb, {
        artifactIds: ['artifact_evidence_1'],
        command: 'pnpm test',
        commandId: 'cmd_evidence_1',
        goalId: 'goal_evidence_1',
        itemIds: ['item_evidence_1'],
        outputPointers: ['stdout:evidence'],
        status: 'passed',
        summary: 'Verification passed.',
        taskId: 'task_evidence_1',
        threadId: 'th_demo',
        turnId: 'turn_evidence_1',
        verificationId: 'gv_evidence_1',
        workspaceId: 'ws_demo',
        now: () => '2026-07-06T00:06:03.000Z',
      });
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/goal-review-records.jsonl');
    expect(exported.checkedFiles).toContain('records/goal-verification-records.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d822',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedThreadId = `th_imported_${body.importedWorkspaceId}_1`;
    const importedTurnId = `tu_imported_${body.importedWorkspaceId}_1`;
    const importedItemId = `it_imported_${body.importedWorkspaceId}_1`;
    const importedArtifactId = `ar_imported_${body.importedWorkspaceId}_1`;
    const importedGoalId = `goal_imported_${body.importedWorkspaceId}_1`;
    const importedTaskId = `task_imported_${body.importedWorkspaceId}_1`;
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      expect(
        listGoalReviewRecordsForTask(importedDb, {
          workspaceId: body.importedWorkspaceId,
          threadId: importedThreadId,
          goalId: importedGoalId,
          taskId: importedTaskId,
        })
      ).toEqual([
        expect.objectContaining({
          artifactIds: [importedArtifactId],
          goalId: importedGoalId,
          itemIds: [importedItemId],
          prompt: 'Review the imported Goal evidence.',
          reviewId: `review_imported_${body.importedWorkspaceId}_1`,
          resolutionSnapshot: {
            outcome: 'complete_goal',
            task: { taskId: importedTaskId, status: 'completed' },
            goal: {
              goalId: importedGoalId,
              status: 'completed',
              currentTaskId: null,
              terminalStopReason: 'completed',
            },
            nextReadyTaskId: null,
          },
          createdByRequestId: 'goal-step-evidence-1',
          reason: null,
          revisionInstruction: null,
          resolutionRequestId: 'goal-review-evidence-resolution-1',
          resolvedByActorId: 'user_demo',
          taskId: importedTaskId,
          turnId: importedTurnId,
          verdict: 'accept',
          workspaceId: body.importedWorkspaceId,
        }),
      ]);
      expect(
        listGoalVerificationRecordsForTask(importedDb, {
          workspaceId: body.importedWorkspaceId,
          threadId: importedThreadId,
          goalId: importedGoalId,
          taskId: importedTaskId,
        })
      ).toEqual([
        expect.objectContaining({
          artifactIds: [importedArtifactId],
          commandId: 'cmd_evidence_1',
          goalId: importedGoalId,
          itemIds: [importedItemId],
          outputPointers: ['stdout:evidence'],
          status: 'passed',
          taskId: importedTaskId,
          turnId: importedTurnId,
          verificationId: `verification_imported_${body.importedWorkspaceId}_1`,
          workspaceId: body.importedWorkspaceId,
        }),
      ]);
      const evidenceAuditRows = importedDb.sqlite
        .prepare('SELECT action, resource FROM audit_events WHERE action IN (?, ?) ORDER BY action')
        .all('goal.review.record', 'goal.verification.record') as Array<Record<string, unknown>>;
      expect(evidenceAuditRows).toEqual([
        {
          action: 'goal.review.record',
          resource: `goal-review:review_imported_${body.importedWorkspaceId}_1`,
        },
        {
          action: 'goal.verification.record',
          resource: `goal-verification:verification_imported_${body.importedWorkspaceId}_1`,
        },
      ]);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('exports and imports MCP tool schema snapshots as line-oriented records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-import-mcp-schema-route-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      sourceDb.sqlite
        .prepare(
          `INSERT INTO mcp_tool_schema_snapshots (
            snapshot_id,
            workspace_id,
            catalog_entry_id,
            source_ref,
            server_version,
            content_digest,
            tools_json,
            source,
            captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'mcpsnap_import_1',
          'ws_demo',
          'github-mcp',
          'mcp/github',
          '1.0.0',
          'sha256:mcp-schema',
          JSON.stringify([
            {
              name: 'repo_status',
              inputSchema: { type: 'object', properties: { owner: { type: 'string' } } },
            },
          ]),
          'live',
          '2026-07-06T00:07:00.000Z'
        );
    } finally {
      sourceDb.sqlite.close();
    }
    const app = createApp({ coreDb, dataRoot, store });
    const exportRes = await app.request('/api/app/workspaces/ws_demo/export', { method: 'POST' });
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());

    expect(exported.checkedFiles).toContain('records/mcp-tool-schema-snapshots.jsonl');

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: 'ws_demo',
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d832',
      }),
    });

    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const body = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedDb = openTestWorkspaceDb(coreDb, body.importedWorkspaceId);
    try {
      const row = importedDb.sqlite
        .prepare(
          `SELECT
            snapshot_id,
            workspace_id,
            catalog_entry_id,
            source_ref,
            server_version,
            content_digest,
            tools_json,
            source,
            captured_at
          FROM mcp_tool_schema_snapshots
          WHERE snapshot_id = ?`
        )
        .get('mcpsnap_import_1') as Record<string, unknown> | undefined;

      expect(row).toMatchObject({
        captured_at: '2026-07-06T00:07:00.000Z',
        catalog_entry_id: 'github-mcp',
        content_digest: 'sha256:mcp-schema',
        server_version: '1.0.0',
        snapshot_id: 'mcpsnap_import_1',
        source: 'live',
        source_ref: 'mcp/github',
        workspace_id: body.importedWorkspaceId,
      });
      expect(JSON.parse(String(row?.tools_json))).toEqual([
        {
          inputSchema: { type: 'object', properties: { owner: { type: 'string' } } },
          name: 'repo_status',
        },
      ]);
    } finally {
      importedDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('serves the App API OpenAPI projection', async () => {
    const app = createApp();

    const res = await app.request('/api/openapi.json');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      info: {
        version: '0.1.0',
      },
      openapi: '3.1.0',
      'x-openkit-protocol-version': PROTOCOL_VERSION,
      paths: {
        '/api/app/storage/layout-report': {
          get: {
            operationId: 'getStorageLayoutReport',
          },
        },
        '/api/app/data-root/backups': {
          post: {
            operationId: 'createDataRootBackup',
          },
        },
        '/api/app/data-root/backups/{backupId}/verify': {
          post: {
            operationId: 'verifyDataRootBackup',
          },
        },
        '/api/app/workspaces/{workspaceId}/export': {
          post: {
            operationId: 'exportWorkspace',
          },
        },
        '/api/app/workspace-imports/dry-run': {
          post: {
            operationId: 'dryRunWorkspaceImport',
          },
        },
      },
    });
  });

  it('allows credentialed browser CORS requests for server-mode auth', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/workspaces', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:4174',
        'access-control-request-method': 'GET',
      },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4174');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('returns a thin workspace record and separate resources payload', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });

    const workspaceRes = await app.request('/api/workspaces/ws_demo');
    const resourcesRes = await app.request('/api/workspaces/ws_demo/resources');

    expect(workspaceRes.status).toBe(200);
    expect(resourcesRes.status).toBe(200);

    const workspace = (await workspaceRes.json()) as Record<string, unknown>;
    const resources = (await resourcesRes.json()) as Record<string, unknown>;

    expect(workspace).toMatchObject({
      id: 'ws_demo',
      kind: 'code',
    });
    expect(workspace.knowledge).toBeUndefined();
    expect(resources).toMatchObject({
      knowledge: expect.any(Array),
      agents: expect.any(Array),
      models: expect.any(Array),
      skills: expect.any(Array),
    });
  });

  it('records usage for workspace knowledge entry writes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-entry-usage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store, turnExecutor: new FakeTurnExecutor() });
    const createRes = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000201',
        kind: 'preference',
        title: 'Temporary preference',
        content: 'Remove this after the test.',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const knowledge = (await createRes.json()) as { id: string };

    const updateRes = await app.request(`/api/workspaces/ws_demo/knowledge/${knowledge.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000213',
        title: 'Updated preference',
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(updateRes.status).toBe(200);

    const deleteRes = await app.request(`/api/workspaces/ws_demo/knowledge/${knowledge.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000214',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(deleteRes.status).toBe(204);

    const listRes = await app.request('/api/workspaces/ws_demo/knowledge');
    const list = (await listRes.json()) as { items: Array<{ id: string }> };

    expect(list.items.some((entry) => entry.id === knowledge.id)).toBe(false);

    const usageRes = await app.request('/api/app/workspaces/ws_demo/capability-usage');
    expect(usageRes.status, await usageRes.clone().text()).toBe(200);
    const usage = CapabilityUsageResponseSchema.parse(await usageRes.json());
    expect(
      usage.capabilityCalls.filter((call) =>
        ['knowledge.entry.create', 'knowledge.entry.update', 'knowledge.entry.delete'].includes(
          call.capabilityId
        )
      )
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'knowledge.entry.create',
        operation: 'knowledge.entry.create',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.entry.update',
        operation: 'knowledge.entry.update',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
      expect.objectContaining({
        capabilityId: 'knowledge.entry.delete',
        operation: 'knowledge.entry.delete',
        serviceRef: 'knowledge-store',
        status: 'succeeded',
      }),
    ]);
    expect(
      usage.usageRecords.filter((record) =>
        ['knowledge-entry-create', 'knowledge-entry-update', 'knowledge-entry-delete'].includes(
          record.source
        )
      )
    ).toEqual([
      expect.objectContaining({ source: 'knowledge-entry-create' }),
      expect.objectContaining({ source: 'knowledge-entry-update' }),
      expect.objectContaining({ source: 'knowledge-entry-delete' }),
    ]);

    coreDb.sqlite.close();
  });

  it('rejects new product turns without durable scheduler storage', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/turns', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: '0190f4c8-0000-7000-8000-000000000202',
        input: 'Ship the update',
        modelId: 'model_codex',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: 'scheduler_unavailable',
    });
  });

  it('starts new turns through the durable scheduler when Core DB is available', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-scheduler-turn-repository-'));

    mkdirSync(join(repositoryPath, '.git'));

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Scheduler repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000216',
          input: 'Run through scheduler',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turn = (await res.json()) as { id: string };

      expect(res.status).toBe(202);
      expect(executor.startContexts[0]).toMatchObject({
        agentSessionId: expect.any(String),
        requestId: '0190f4c8-0000-7000-8000-000000000216',
        sandboxBindingRef: expect.stringMatching(/^lease-binding:/),
      });
      expect(turn.id).toMatch(/^turn_0190f4c8-0000-7000-8000-000000000216/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts Task Mode through the worker coordinator and one bounded worker turn', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-task-mode-repository-'));
    const requestId = '0190f4c8-0000-7000-8000-000000000301';
    const input = 'Implement the focused Task Mode fix.';

    mkdirSync(join(repositoryPath, '.git'));

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Task Mode repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartTaskModeResponseSchema.parse(await res.json());

      expect(parsed).not.toHaveProperty('decision');
      expect(parsed.state).toBe('completed');
      expect(parsed.turn.status).toBe('completed');
      expect(parsed.turn.id).toMatch(/^turn_0190f4c8-0000-7000-8000-000000000301/);
      expect(parsed.completion).toEqual({
        itemId: `it_assistant_${parsed.turn.id}`,
        text: 'Completed by fake executor.',
      });
      expect(parsed.evidence).toEqual({
        itemIds: [`it_user_${parsed.turn.id}`, `it_assistant_${parsed.turn.id}`],
        artifactIds: [],
        reviewIds: [],
      });
      const workerInput = store
        .listThreadItems('ws_demo', 'th_demo')
        .find((item) => item.id === `it_user_${parsed.turn.id}`);
      expect(workerInput?.type).toBe('user-message');
      const expectedWorkerRequest = createWorkerCoordinatorDecision({
        prompt: input,
        readiness: [
          {
            agentId: 'agent_codex_host',
            displayName: 'Codex Host Agent',
            runtime: 'codex',
            readiness: 'ready',
          },
        ],
        threadState: { status: 'idle', threadId: 'th_demo' },
        workspaceSummary: { name: 'Demo Workspace', workspaceId: 'ws_demo' },
      }).workerRequest;
      expect(expectedWorkerRequest).not.toBeNull();
      expect(
        StructuredWorkerDelegationRequestSchema.parse(
          JSON.parse(workerInput?.type === 'user-message' ? workerInput.text : '')
        )
      ).toEqual(expectedWorkerRequest);
      expect(
        store.getCommandRequest('task.start', requestId, {
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        })?.response.snapshot
      ).toBeUndefined();

      const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });
      const conflictRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input: 'Implement a different focused Task Mode fix.' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(replayRes.status).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replayRes.json())).toEqual(parsed);
      store.updateTurn(parsed.turn.id, { status: 'cancelled' });
      const cancelledReplayRes = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/task',
        {
          method: 'POST',
          body: JSON.stringify({ requestId, input }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(cancelledReplayRes.status).toBe(409);
      await expect(cancelledReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(executor.startContexts).toHaveLength(1);
      const sandboxBindingRef = executor.startContexts[0]!.sandboxBindingRef!;
      expect(
        requireSchedulerSessionLease(coreDb, sandboxBindingRef.slice('lease-binding:'.length))
      ).toMatchObject({
        status: 'released',
        releaseReason: 'turn-completed',
        turnId: parsed.turn.id,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('recovers a direct Task receipt from its terminal checkpoint without another worker turn', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-task-receipt-recovery-'));
    const requestId = '0190f4c8-0000-7000-8000-000000000302';
    const input = 'Implement the focused Task receipt recovery fix.';

    mkdirSync(join(repositoryPath, '.git'));

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Task receipt recovery repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });
      const receiptWrite = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('simulated Task receipt write failure');
      });
      const firstRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });
      receiptWrite.mockRestore();

      expect(firstRes.status).toBe(409);
      await expect(firstRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      const turns = store.listThreadTurns('ws_demo', 'th_demo');
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      const checkpointDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(listExportableWorkerCheckpoints(checkpointDb, 'ws_demo')).toEqual([
          expect.objectContaining({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: turn.id,
            goalId: null,
            taskId: null,
            requestId,
            stage: 'completed',
            stopReason: 'completed',
          }),
        ]);
      } finally {
        checkpointDb.sqlite.close();
      }

      const conflictRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input: 'Implement a different Task result.' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(executor.startContexts).toHaveLength(1);

      const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });

      expect(replayRes.status).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replayRes.json())).toMatchObject({
        state: 'completed',
        turn: { id: turn.id },
      });
      expect(executor.startContexts).toHaveLength(1);
      expect(
        store.getCommandRequest('task.start', requestId, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
        })
      ).not.toBeNull();
      const recoveredDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(getWorkerCheckpoint(recoveredDb, 'ws_demo', 'th_demo', turn.id)).toBeNull();
      } finally {
        recoveredDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects Task Mode in the Quick Chat workspace', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request(
        '/api/app/workspaces/ws_quick_chat/threads/th_quick_chat/task',
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000319',
            input: 'Implement a focused fix.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('closes a direct Task Gate as blocked without resuming worker execution', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb, turnExecutor: new SimulatedTurnExecutor() });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-task-mode-paused-repository-'));
    const taskRequestId = '0190f4c8-0000-7000-8000-000000000308';
    const taskInput = 'Implement the bounded Task Mode simulator fix.';

    mkdirSync(join(repositoryPath, '.git'));

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Task Mode paused repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({
          requestId: taskRequestId,
          input: taskInput,
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartTaskModeResponseSchema.parse(await res.json());

      expect(parsed.state).toBe('awaiting-human');
      expect(parsed.turn.status).toBe('awaiting_human');
      expect(parsed.completion).toBeNull();
      expect(parsed.evidence.itemIds).toEqual(
        expect.arrayContaining([
          `it_assistant_${parsed.turn.id}`,
          `it_approval_request_${parsed.turn.id}`,
        ])
      );
      expect(parsed.turn.humanGate?.kind).toBe('approval');
      if (parsed.turn.humanGate?.kind !== 'approval') {
        throw new Error('Expected the simulator approval Gate.');
      }
      const approvalRes = await app.request(
        `/api/approvals/${parsed.turn.humanGate.approvalRequestId}/respond`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000309',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: parsed.turn.id,
            decision: 'granted',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );
      expect(approvalRes.status).toBe(200);

      const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId: taskRequestId, input: taskInput }),
        headers: { 'content-type': 'application/json' },
      });
      expect(replayRes.status).toBe(202);
      const replay = StartTaskModeResponseSchema.parse(await replayRes.json());
      expect(replay).toMatchObject({
        state: 'blocked',
        turn: { id: parsed.turn.id, status: 'completed' },
        completion: null,
      });
      expect(replay.evidence.itemIds).toContain(`it_approval_decision_${parsed.turn.id}`);
      expect(replay.evidence.itemIds).not.toContain(`it_user_input_request_${parsed.turn.id}`);
      expect(replay.evidence.artifactIds).toEqual([]);
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(
          getWorkerCheckpoint(workspaceDb, 'ws_demo', 'th_demo', parsed.turn.id)
        ).toBeNull();
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects Task Mode review evidence when worker output stages workspace changes', async () => {
    const coreDb = createCoreDb();
    const executor = new (class extends FakeTurnExecutor {
      public override async startTurn(
        store: FsStore,
        turnId: string,
        input: string,
        context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
      ): Promise<void> {
        await super.startTurn(store, turnId, input, context);

        const turn = store.getTurnById(turnId);
        const timestamp = turn.completedAt ?? new Date().toISOString();
        const patchText = 'diff --git a/docs/task.md b/docs/task.md\n';
        const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
        const artifact = store.createArtifact({
          id: `ar_task_review_${turnId}`,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId,
          kind: 'diff',
          title: 'Task Mode workspace changes',
          status: 'ready',
          summary: 'Task Mode workspace changes ready for review.',
          version: 1,
          content: { format: 'text', body: patchText },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const reviewId = `swr_task_${turnId}`;
        const workspaceDb = openTestWorkspaceDb(coreDb, turn.workspaceId);
        const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
          artifactId: artifact.id,
          changeSet: {
            artifactIds: [artifact.id],
            base: { commit: 'abc123', contentDigest: null },
            bundle: null,
            changedPaths: [{ binary: false, path: 'docs/task.md', status: 'modified' }],
            createdAt: timestamp,
            evidenceRefs: [{ kind: 'worker', ref: turnId }],
            head: { commit: 'def456', contentDigest: null },
            id: `wcs_${turnId}`,
            inputSnapshotId: `wis_${turnId}`,
            materializationRecordId: `wmr_${turnId}`,
            patch: {
              bytes: Buffer.byteLength(patchText, 'utf8'),
              digest: patchDigest,
              ref: `artifact://${artifact.id}`,
            },
            redaction: { notes: [], status: 'redacted' },
            resourceId: 'repo_default',
            strategy: 'git',
            workspaceId: turn.workspaceId,
          },
          patchPayload: {
            bytes: Buffer.byteLength(patchText, 'utf8'),
            digest: patchDigest,
            mediaType: 'text/x-diff',
            text: patchText,
          },
          review: {
            actionCenterRowId: `workspace-review:${reviewId}`,
            changeSetId: `wcs_${turnId}`,
            createdAt: timestamp,
            diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
            id: reviewId,
            riskSummary: '1 changed path staged for human review.',
            staging: {
              branch: `openkit/review/${reviewId}`,
              ref: `staging://workspace/${turnId}`,
              strategy: 'git_worktree',
            },
            status: 'pending',
            updatedAt: timestamp,
            validation: [],
            workspaceId: turn.workspaceId,
          },
        };

        try {
          recordTestWorkspaceReviewMaterialization(workspaceDb, item);
          recordWorkspaceSyncReview(workspaceDb, { item });
        } finally {
          workspaceDb.sqlite.close();
        }
      }
    })();
    const app = createApp({ coreDb, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-task-mode-review-repository-'));

    mkdirSync(join(repositoryPath, '.git'));

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Task Mode review repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000311',
          input: 'Implement the focused Task Mode fix.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartTaskModeResponseSchema.parse(await res.json());

      expect(parsed.evidence.artifactIds).toContain(`ar_task_review_${parsed.turn.id}`);
      expect(parsed.evidence.reviewIds).toEqual([`swr_task_${parsed.turn.id}`]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts Task Mode when Chat Mode accepts a task handoff', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-task-handoff-repository-'));
    const requestId = '0190f4c8-0000-7000-8000-000000000305';
    const input = 'Implement the focused Task Mode fix.';

    mkdirSync(join(repositoryPath, '.git'));

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Chat Task Mode repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartChatModeResponseSchema.parse(await res.json());
      const acceptedTurnIds = store
        .listThreadTurns('ws_demo', 'th_demo')
        .map((turn) => turn.id)
        .sort();

      const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });
      const conflictRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({ requestId, input: 'Implement a different focused Task Mode fix.' }),
        headers: { 'content-type': 'application/json' },
      });
      const directTaskRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });

      expect(parsed).toMatchObject({
        outcome: 'task-handoff',
        handoff: { targetMode: 'task' },
        item: { type: 'status', title: 'Task Mode handoff' },
      });
      expect(replayRes.status).toBe(202);
      const replay = StartChatModeResponseSchema.parse(await replayRes.json());
      expect(replay.turn.id).toBe(parsed.turn.id);
      expect(replay.item.id).toBe(parsed.item.id);
      expect(replay.handoff).toEqual(parsed.handoff);
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
      expect(directTaskRes.status).toBe(202);
      const directTask = StartTaskModeResponseSchema.parse(await directTaskRes.json());
      expect(acceptedTurnIds).not.toContain(directTask.turn.id);
      expect(executor.startContexts).toHaveLength(2);
      expect(executor.startContexts[0]).toMatchObject({
        requestId,
      });
      expect(
        store
          .listThreadTurns('ws_demo', 'th_demo')
          .map((turn) => turn.id)
          .sort()
      ).toEqual([...acceptedTurnIds, directTask.turn.id].sort());
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts Goal Mode when Chat Mode accepts a goal handoff', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000306',
          input: 'Plan a multi-step release goal for NanoCore.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'goal-handoff',
        handoff: { targetMode: 'goal' },
        item: { type: 'status', title: 'Goal Mode handoff' },
      });
      expect(executor.startContexts).toHaveLength(0);

      const goalRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/goal');
      const goal = ThreadGoalSummaryResponseSchema.parse(await goalRes.json()).goal;

      expect(goal).toMatchObject({
        objective: 'Plan a multi-step release goal for NanoCore.',
        status: 'planning',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('asks for clarification for vague Chat Mode help prompts', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      for (const [index, input] of ['Can you help with this?', 'What should I do?'].entries()) {
        const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
          method: 'POST',
          body: JSON.stringify({
            requestId: `0190f4c8-0000-7000-8000-00000000031${index}`,
            input,
          }),
          headers: { 'content-type': 'application/json' },
        });

        expect(res.status).toBe(202);
        const parsed = StartChatModeResponseSchema.parse(await res.json());

        expect(parsed).toMatchObject({
          outcome: 'clarification-needed',
          item: { type: 'user-input-request' },
          turn: { status: 'awaiting_human' },
        });
      }
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('allows lightweight Chat Mode in the Quick Chat workspace without starting workers', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const thread = store.createThread('ws_quick_chat', 'Quick Chat thread');

    try {
      const res = await app.request(`/api/app/workspaces/ws_quick_chat/threads/${thread.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000321',
          input: 'Can you help with this?',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'clarification-needed',
        handoff: null,
        turn: { workspaceId: 'ws_quick_chat', threadId: thread.id, status: 'awaiting_human' },
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects project work prompts in Quick Chat Chat Mode without coordinator handoff', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const thread = store.createThread('ws_quick_chat', 'Quick Chat project request');

    try {
      const res = await app.request(`/api/app/workspaces/ws_quick_chat/threads/${thread.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000322',
          input: 'Implement the focused worker fix.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses Chat Mode external search requests until a search capability exists', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000320',
          input: 'Search the web for NanoCore release notes.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation: 'External search is not enabled for Chat Mode.',
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('answers narrow Chat Mode repository file-list questions through read-only inspection', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-readonly-repository-'));

    mkdirSync(join(repositoryPath, '.git'));
    mkdirSync(join(repositoryPath, 'docs'));
    writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n');
    writeFileSync(join(repositoryPath, 'docs', 'guide.md'), '# Guide\n');

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Chat read-only repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000309',
          input: 'List repository files.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'answered',
        explanation: 'The Assistant answered from a read-only repository inspection.',
        item: { type: 'assistant-message' },
      });
      expect(parsed.item.type === 'assistant-message' ? parsed.item.text : '').toContain(
        'README.md'
      );
      expect(parsed.item.type === 'assistant-message' ? parsed.item.text : '').toContain('docs/');

      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toEqual([
          expect.objectContaining({
            capabilityId: 'assistant.repository.read',
            family: 'workspace',
            operation: 'repository.root_list',
            requestId: '0190f4c8-0000-7000-8000-000000000309',
            status: 'succeeded',
            threadId: 'th_demo',
          }),
        ]);
        expect(listWorkspaceAuditEvents(workspaceDb, 'ws_demo')).toEqual([
          expect.objectContaining({
            action: 'capability.finish',
            category: 'capability',
            outcome: 'succeeded',
            resource: 'capability:assistant.repository.read',
          }),
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses Chat Mode repository inspection when workspace policy disables it', async () => {
    const coreDb = createCoreDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-policy-repository-'));
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot: coreDb.dataRoot,
        workspaceConfigs: [
          {
            userId: LOCAL_USER_ID,
            workspaceId: 'ws_demo',
            path: join(
              coreDb.dataRoot,
              'users',
              LOCAL_USER_ID,
              'workspaces',
              'ws_demo',
              'config',
              'workspace.jsonc'
            ),
            config: {
              schemaVersion: 1,
              workspace: {
                assistant: {
                  repositoryInspection: {
                    enabled: false,
                  },
                },
              },
            },
          },
        ],
      }),
    });
    const app = createApp({ coreDb, runtimeConfigManager });

    writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n');

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Chat policy repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000312',
          input: 'List repository files.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation: 'Workspace policy disables Chat Mode repository inspection.',
        item: {
          summary: 'Workspace policy disables Chat Mode repository inspection.',
          type: 'status',
        },
      });
      expect(JSON.stringify(parsed)).not.toContain('README.md');

      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('applies Chat Mode repository inspection path exclusions from workspace policy', async () => {
    const coreDb = createCoreDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-policy-exclusions-'));
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot: coreDb.dataRoot,
        workspaceConfigs: [
          {
            userId: LOCAL_USER_ID,
            workspaceId: 'ws_demo',
            path: join(
              coreDb.dataRoot,
              'users',
              LOCAL_USER_ID,
              'workspaces',
              'ws_demo',
              'config',
              'workspace.jsonc'
            ),
            config: {
              schemaVersion: 1,
              workspace: {
                assistant: {
                  repositoryInspection: {
                    excludedPaths: ['docs'],
                  },
                },
              },
            },
          },
        ],
      }),
    });
    const app = createApp({ coreDb, runtimeConfigManager });

    mkdirSync(join(repositoryPath, 'docs'));
    writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n');
    writeFileSync(join(repositoryPath, 'docs', 'guide.md'), '# Guide\n');

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Chat policy exclusions repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const listRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000313',
          input: 'List repository files.',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const readRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000314',
          input: 'Read repository file docs/guide.md.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(listRes.status).toBe(202);
      const listParsed = StartChatModeResponseSchema.parse(await listRes.json());
      const listText = listParsed.item.type === 'assistant-message' ? listParsed.item.text : '';

      expect(listText).toContain('README.md');
      expect(listText).not.toContain('docs/');

      expect(readRes.status).toBe(202);
      const readParsed = StartChatModeResponseSchema.parse(await readRes.json());

      expect(readParsed).toMatchObject({
        outcome: 'refused',
        explanation: 'Workspace policy excludes that repository path from Chat Mode inspection.',
        item: {
          summary: 'Workspace policy excludes that repository path from Chat Mode inspection.',
          type: 'status',
        },
      });
      expect(JSON.stringify(readParsed)).not.toContain('Guide');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('answers narrow Chat Mode repository directory file-list questions through bounded read-only inspection', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-readonly-dir-repository-'));

    mkdirSync(join(repositoryPath, '.git'));
    mkdirSync(join(repositoryPath, 'docs'));
    writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n');
    writeFileSync(join(repositoryPath, 'docs', 'guide.md'), '# Guide\n');

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Chat read-only directory repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000310',
          input: 'List repository files in docs.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartChatModeResponseSchema.parse(await res.json());
      const text = parsed.item.type === 'assistant-message' ? parsed.item.text : '';

      expect(parsed).toMatchObject({
        outcome: 'answered',
        explanation: 'The Assistant answered from a read-only repository inspection.',
        item: { type: 'assistant-message' },
      });
      expect(text).toContain('Repository docs/ entries:');
      expect(text).toContain('guide.md');
      expect(text).not.toContain('README.md');
      expect(text).not.toContain(repositoryPath);
      expect(text).not.toContain('.git');

      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toEqual([
          expect.objectContaining({
            capabilityId: 'assistant.repository.read',
            family: 'workspace',
            operation: 'repository.directory_list',
            requestId: '0190f4c8-0000-7000-8000-000000000310',
            status: 'succeeded',
            threadId: 'th_demo',
          }),
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('answers narrow Chat Mode repository file-read questions through bounded read-only inspection', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-readonly-file-repository-'));

    mkdirSync(join(repositoryPath, '.git'));
    mkdirSync(join(repositoryPath, 'docs'));
    writeFileSync(
      join(repositoryPath, 'docs', 'guide.md'),
      '# Guide\n\nThis file proves safe Chat Mode reads.\n\nsk-openkit-secret\n'
    );

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Chat read-only file repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000311',
          input: 'Read repository file docs/guide.md.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartChatModeResponseSchema.parse(await res.json());
      const text = parsed.item.type === 'assistant-message' ? parsed.item.text : '';

      expect(parsed).toMatchObject({
        outcome: 'answered',
        explanation: 'The Assistant answered from a read-only repository inspection.',
        item: { type: 'assistant-message' },
      });
      expect(text).toContain('Repository file docs/guide.md:');
      expect(text).toContain('This file proves safe Chat Mode reads.');
      expect(text).toContain('[redacted]');
      expect(text).not.toContain('sk-openkit-secret');
      expect(text).not.toContain(repositoryPath);

      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toEqual([
          expect.objectContaining({
            capabilityId: 'assistant.repository.read',
            family: 'workspace',
            operation: 'repository.file_read',
            requestId: '0190f4c8-0000-7000-8000-000000000311',
            status: 'succeeded',
            threadId: 'th_demo',
          }),
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not route mutating Chat Mode repository requests through read-only inspection', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-chat-readonly-boundary-'));

    mkdirSync(join(repositoryPath, '.git'));
    writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n');

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Chat read-only boundary repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000315',
          input: 'Delete repository file README.md.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'task-handoff',
        handoff: { targetMode: 'task' },
      });
      expect(JSON.stringify(parsed)).not.toContain('# Demo');
      expect(executor.startContexts).toHaveLength(1);

      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses Chat Mode worker handoff when no worker candidate is ready', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();

    for (const agent of store.getWorkspaceResources('ws_demo').agents) {
      store.upsertAgent('ws_demo', { ...agent, status: 'disabled' });
    }

    const app = createApp({ coreDb, store, turnExecutor: executor });

    try {
      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000316',
          input: 'Implement the focused worker fix.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation: 'No ready Codex or OpenCode worker candidate is available.',
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses Chat Mode retry requests instead of falling back to quick chat', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000317',
          input: 'Retry the previous worker turn.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation: 'The request asks to retry prior worker execution.',
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      input: 'Review the previous worker output.',
      explanation: 'The request is asking to evaluate recent work rather than start new execution.',
    },
    {
      input: 'Refine the previous result.',
      explanation: 'The request appears to refine prior output in the current thread.',
    },
    {
      input: 'Hand off this work to another worker.',
      explanation: 'The request asks to hand work to another worker or phase.',
    },
  ])('refuses Chat Mode coordinator-only requests for "$input"', async ({ explanation, input }) => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000319',
          input,
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const parsed = StartChatModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        outcome: 'refused',
        explanation,
        handoff: null,
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects Goal Mode in the Quick Chat workspace', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb, turnExecutor: new FakeTurnExecutor() });

    try {
      const res = await app.request(
        '/api/app/workspaces/ws_quick_chat/threads/th_quick_chat/goal',
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'goal-start-quick-chat',
            objective: 'Plan a multi-step release goal.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not silently run Task Mode when the coordinator selects quick chat', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });
    const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
      method: 'POST',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000302',
        input: 'What is OpenKit?',
      }),
      headers: { 'content-type': 'application/json' },
    });

    try {
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        code: 'task_mode_not_delegated',
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not silently run Task Mode when the coordinator asks to clarify', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });
    const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
      method: 'POST',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000318',
        input: 'Help.',
      }),
      headers: { 'content-type': 'application/json' },
    });

    try {
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        code: 'task_mode_not_delegated',
        message: 'The request needs clarification before routing.',
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('escalates Task Mode requests that need Goal Mode planning', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const requestId = '0190f4c8-0000-7000-8000-000000000307';
    const input = 'Plan a multi-step release goal for NanoCore.';

    try {
      const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(202);
      const parsed = StartTaskModeResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        state: 'escalated-to-goal',
        escalation: {
          targetMode: 'goal',
          goalId: expect.stringMatching(/^goal_/),
        },
      });
      expect(executor.startContexts).toHaveLength(0);
      expect(parsed).not.toHaveProperty('decision');
      expect(
        store.getCommandRequest('task.start', requestId, {
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        })?.response.snapshot
      ).toBeUndefined();

      const replayRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({ requestId, input }),
        headers: { 'content-type': 'application/json' },
      });

      expect(replayRes.status).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replayRes.json())).toEqual(parsed);

      const goalRes = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/goal');
      const goal = ThreadGoalSummaryResponseSchema.parse(await goalRes.json()).goal;

      expect(goal).toMatchObject({
        objective: 'Plan a multi-step release goal for NanoCore.',
        status: 'planning',
      });
      expect(goal?.goalId).toBe(parsed.escalation?.goalId);
      expect(store.listCommandRequests().map((record) => record.command)).toEqual(['task.start']);

      const creationItem = parsed.turn.items.find((item) => item.type === 'user-message');

      if (!creationItem) {
        throw new Error('Expected the Goal creation Item.');
      }

      store.updateItem(creationItem.id, { status: 'in_progress', completedAt: null });
      const contradictedReplayRes = await app.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/task',
        {
          method: 'POST',
          body: JSON.stringify({ requestId, input }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(contradictedReplayRes.status).toBe(409);
      await expect(contradictedReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns a typed 400 error for unsupported turn model overrides', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/turns', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: '0190f4c8-0000-7000-8000-000000000203',
        input: 'Ship the update',
        modelId: 'model_missing',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'model_not_found',
      message: 'Model not found: model_missing.',
    });
  });

  it('rejects direct worker turns in the Quick Chat workspace', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, turnExecutor: executor });

    try {
      const res = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_quick_chat',
          threadId: 'th_quick_chat',
          requestId: '0190f4c8-0000-7000-8000-000000000320',
          input: 'Run a worker turn.',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns protocol-valid meta event families', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/meta');

    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = MetaResponseSchema.parse(body);

    expect(parsed.eventFamilies).toContain('item.created');
    expect(parsed.eventFamilies).toContain('thread.updated');
    expect(parsed.eventFamilies).not.toContain('approval.requested');
  });

  it('reports active container worker capabilities in meta by default', async () => {
    const coreDb = createCoreDb();

    try {
      const app = createNanoCoreApp({ coreDb });
      const res = await app.request('/api/meta');

      expect(res.status).toBe(200);

      const parsed = MetaResponseSchema.parse(await res.json());

      expect(parsed.capabilities).toEqual([
        'core.artifacts',
        'core.agent_session.visible',
        'core.stream.replay',
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('clears workspace default model and agent selections with explicit nulls', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/workspaces/ws_demo', {
      method: 'PATCH',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000210',
        defaults: {
          defaultModelId: null,
          defaultAgentId: null,
          defaultSkillIds: [],
        },
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      defaults: {
        defaultModelId: null,
        defaultAgentId: null,
        defaultSkillIds: [],
      },
    });
  });

  it('creates a thread from the name field used by the protocol package', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/workspaces/ws_demo/threads', {
      method: 'POST',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000204',
        name: 'Follow-up thread',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(201);

    const thread = ThreadSchema.parse(await res.json());

    expect(thread.name).toBe('Follow-up thread');
    expect(thread.preview).toBe('Follow-up thread');
  });

  it('deduplicates repeated workspace, knowledge, thread, and artifact commands', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() });

    const workspaceBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000501',
      name: 'Idempotent workspace',
    };
    const workspaceFirst = await app.request('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify(workspaceBody),
      headers: jsonHeaders(),
    });
    const workspaceSecond = await app.request('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify(workspaceBody),
      headers: jsonHeaders(),
    });
    const workspace = (await workspaceFirst.json()) as { id: string };
    const duplicateWorkspace = (await workspaceSecond.json()) as { id: string };

    expect(duplicateWorkspace.id).toBe(workspace.id);
    expect(
      store.listWorkspaces().filter((item) => item.name === 'Idempotent workspace')
    ).toHaveLength(1);

    const workspaceUpdateBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000502',
      name: 'Idempotent workspace renamed',
    };
    const workspaceUpdateFirst = await app.request(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      body: JSON.stringify(workspaceUpdateBody),
      headers: jsonHeaders(),
    });
    const workspaceUpdateSecond = await app.request(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      body: JSON.stringify(workspaceUpdateBody),
      headers: jsonHeaders(),
    });

    expect((await workspaceUpdateFirst.json()) as { id: string; name: string }).toMatchObject({
      id: workspace.id,
      name: 'Idempotent workspace renamed',
    });
    expect((await workspaceUpdateSecond.json()) as { id: string; name: string }).toMatchObject({
      id: workspace.id,
      name: 'Idempotent workspace renamed',
    });

    const knowledgeBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000503',
      kind: 'preference',
      title: 'Idempotent knowledge',
      content: 'Store this once.',
    };
    const knowledgeFirst = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      body: JSON.stringify(knowledgeBody),
      headers: jsonHeaders(),
    });
    const knowledgeSecond = await app.request('/api/workspaces/ws_demo/knowledge', {
      method: 'POST',
      body: JSON.stringify(knowledgeBody),
      headers: jsonHeaders(),
    });
    const knowledge = (await knowledgeFirst.json()) as { id: string };
    const duplicateKnowledge = (await knowledgeSecond.json()) as { id: string };

    expect(duplicateKnowledge.id).toBe(knowledge.id);
    expect(
      store.listKnowledge('ws_demo').filter((entry) => entry.title === 'Idempotent knowledge')
    ).toHaveLength(1);

    const knowledgeUpdateBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000504',
      title: 'Idempotent knowledge updated',
    };
    const knowledgeUpdateFirst = await app.request(
      `/api/workspaces/ws_demo/knowledge/${knowledge.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(knowledgeUpdateBody),
        headers: jsonHeaders(),
      }
    );
    const knowledgeUpdateSecond = await app.request(
      `/api/workspaces/ws_demo/knowledge/${knowledge.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(knowledgeUpdateBody),
        headers: jsonHeaders(),
      }
    );

    expect((await knowledgeUpdateFirst.json()) as { id: string; title: string }).toMatchObject({
      id: knowledge.id,
      title: 'Idempotent knowledge updated',
    });
    expect((await knowledgeUpdateSecond.json()) as { id: string; title: string }).toMatchObject({
      id: knowledge.id,
      title: 'Idempotent knowledge updated',
    });

    const knowledgeDeleteBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000514',
    };
    const knowledgeDeleteFirst = await app.request(
      `/api/workspaces/ws_demo/knowledge/${knowledge.id}`,
      {
        method: 'DELETE',
        body: JSON.stringify(knowledgeDeleteBody),
        headers: jsonHeaders(),
      }
    );
    const knowledgeDeleteSecond = await app.request(
      `/api/workspaces/ws_demo/knowledge/${knowledge.id}`,
      {
        method: 'DELETE',
        body: JSON.stringify(knowledgeDeleteBody),
        headers: jsonHeaders(),
      }
    );
    const knowledgeDeleteNewRequest = await app.request(
      `/api/workspaces/ws_demo/knowledge/${knowledge.id}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000515',
        }),
        headers: jsonHeaders(),
      }
    );

    expect(knowledgeDeleteFirst.status).toBe(204);
    expect(knowledgeDeleteSecond.status).toBe(204);
    expect(knowledgeDeleteNewRequest.status).toBe(404);

    const threadBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000505',
      name: 'Idempotent thread',
    };
    const threadFirst = await app.request('/api/workspaces/ws_demo/threads', {
      method: 'POST',
      body: JSON.stringify(threadBody),
      headers: jsonHeaders(),
    });
    const threadSecond = await app.request('/api/workspaces/ws_demo/threads', {
      method: 'POST',
      body: JSON.stringify(threadBody),
      headers: jsonHeaders(),
    });
    const thread = (await threadFirst.json()) as { id: string };
    const duplicateThread = (await threadSecond.json()) as { id: string };

    expect(duplicateThread.id).toBe(thread.id);
    expect(
      store.listThreads('ws_demo').filter((item) => item.name === 'Idempotent thread')
    ).toHaveLength(1);

    const threadUpdateBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000506',
      name: 'Idempotent thread updated',
    };
    const threadUpdateFirst = await app.request(`/api/workspaces/ws_demo/threads/${thread.id}`, {
      method: 'PATCH',
      body: JSON.stringify(threadUpdateBody),
      headers: jsonHeaders(),
    });
    const threadUpdateSecond = await app.request(`/api/workspaces/ws_demo/threads/${thread.id}`, {
      method: 'PATCH',
      body: JSON.stringify(threadUpdateBody),
      headers: jsonHeaders(),
    });

    expect((await threadUpdateFirst.json()) as { id: string; name: string }).toMatchObject({
      id: thread.id,
      name: 'Idempotent thread updated',
    });
    expect((await threadUpdateSecond.json()) as { id: string; name: string }).toMatchObject({
      id: thread.id,
      name: 'Idempotent thread updated',
    });

    const threadArchiveBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000507',
    };
    await app.request(`/api/workspaces/ws_demo/threads/${thread.id}/archive`, {
      method: 'POST',
      body: JSON.stringify(threadArchiveBody),
      headers: jsonHeaders(),
    });
    const threadArchiveSecond = await app.request(
      `/api/workspaces/ws_demo/threads/${thread.id}/archive`,
      {
        method: 'POST',
        body: JSON.stringify(threadArchiveBody),
        headers: jsonHeaders(),
      }
    );

    expect((await threadArchiveSecond.json()) as { id: string; status: string }).toMatchObject({
      id: thread.id,
      status: 'archived',
    });

    const timestamp = new Date().toISOString();
    store.createArtifact({
      id: 'ar_idempotent',
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      kind: 'summary',
      title: 'Idempotent artifact',
      status: 'draft',
      summary: null,
      version: 1,
      content: { format: 'markdown', body: '# Artifact' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const artifactBody = {
      requestId: '0190f4c8-0000-7000-8000-000000000508',
      title: 'Idempotent artifact updated',
      status: 'ready',
    };
    const artifactFirst = await app.request('/api/workspaces/ws_demo/artifacts/ar_idempotent', {
      method: 'PATCH',
      body: JSON.stringify(artifactBody),
      headers: jsonHeaders(),
    });
    const artifactSecond = await app.request('/api/workspaces/ws_demo/artifacts/ar_idempotent', {
      method: 'PATCH',
      body: JSON.stringify(artifactBody),
      headers: jsonHeaders(),
    });

    expect((await artifactFirst.json()) as { id: string; title: string }).toMatchObject({
      id: 'ar_idempotent',
      title: 'Idempotent artifact updated',
    });
    expect((await artifactSecond.json()) as { id: string; title: string }).toMatchObject({
      id: 'ar_idempotent',
      title: 'Idempotent artifact updated',
    });
  });

  it('deduplicates concurrent start-turn commands by request id', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new DelayedTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-idempotent-turn-repository-'));
    const body = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      requestId: '0190f4c8-0000-7000-8000-000000000509',
      input: 'Run the idempotent turn',
    };

    mkdirSync(join(repositoryPath, '.git'));

    try {
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Idempotent turn repository',
          localPath: repositoryPath,
        }),
        headers: jsonHeaders(),
      });

      const first = app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: jsonHeaders(),
      });

      await executor.waitForStart();

      const second = app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: jsonHeaders(),
      });
      const competing = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          requestId: '0190f4c8-0000-7000-8000-000000000517',
        }),
        headers: jsonHeaders(),
      });

      await Promise.resolve();
      expect(competing.status).toBe(409);
      await expect(competing.json()).resolves.toMatchObject({ code: 'thread_busy' });
      expect(executor.starts).toBe(1);

      executor.release();
      const [firstRes, secondRes] = await Promise.all([first, second]);
      const firstTurn = (await firstRes.json()) as { id: string };
      const secondTurn = (await secondRes.json()) as { id: string };

      expect(secondTurn.id).toBe(firstTurn.id);
      expect(executor.starts).toBe(1);
      expect(
        store.listThreadTurns('ws_demo', 'th_demo').filter((turn) => turn.id === firstTurn.id)
      ).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects implicit turn submission while active and allows the same request after terminal', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-active-turn-steering-repository-'));
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const thread = store.createThread('ws_demo', 'Active turn steering');
    const activeTurn = store.updateTurn(
      store.createTurn('ws_demo', thread.id, 'Keep this turn active').id,
      { status: 'running' }
    );
    const body = {
      workspaceId: 'ws_demo',
      threadId: thread.id,
      requestId: '0190f4c8-0000-7000-8000-000000000516',
      input: 'Apply this to the active turn.',
    };

    mkdirSync(join(repositoryPath, '.git'));
    upsertWorkspaceRepositoryResource(workspaceDb, {
      workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
      workspaceId: 'ws_demo',
      displayName: 'Active turn steering repository',
      localPath: repositoryPath,
    });

    try {
      const first = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: jsonHeaders(),
      });
      const replay = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: jsonHeaders(),
      });
      const admissionCountWhileActive = (
        coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries WHERE request_id = ?')
          .get(body.requestId) as { readonly count: number }
      ).count;

      expect(first.status).toBe(409);
      await expect(first.json()).resolves.toMatchObject({ code: 'thread_busy' });
      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toMatchObject({ code: 'thread_busy' });
      expect(admissionCountWhileActive).toBe(0);
      expect(executor.startContexts).toHaveLength(0);
      expect(store.listThreadItems('ws_demo', thread.id)).toEqual([]);
      expect(store.listThreadTurns('ws_demo', thread.id).map((turn) => turn.id)).toEqual([
        activeTurn.id,
      ]);

      store.updateTurn(activeTurn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const accepted = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: jsonHeaders(),
      });
      const acceptedTurn = (await accepted.json()) as { id: string };

      expect(accepted.status).toBe(202);
      expect(acceptedTurn.id).not.toBe(activeTurn.id);
      expect(executor.startContexts).toHaveLength(1);
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(2);
      expect(store.listThreadItems('ws_demo', thread.id)).toContainEqual(
        expect.objectContaining({
          turnId: acceptedTurn.id,
          type: 'user-message',
          text: body.input,
        })
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('deduplicates follow-up input, interrupt, and approval response commands', async () => {
    const store = createDemoStore();
    const interactiveExecutor = new InteractiveTurnExecutor();
    const interactiveApp = createApp({ store, turnExecutor: interactiveExecutor });
    const createdFollowUpTurn = store.createTurn('ws_demo', 'th_demo', 'Await input');
    const followUpItem = store.createItem({
      id: 'it_follow_up_question',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: createdFollowUpTurn.id,
      type: 'user-input-request',
      status: 'completed',
      userInputRequestId: 'ui_follow_up',
      prompt: 'Continue?',
      questions: [
        {
          id: 'continue',
          header: 'Continue',
          question: 'Continue?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: createdFollowUpTurn.startedAt ?? new Date().toISOString(),
      completedAt: createdFollowUpTurn.startedAt ?? new Date().toISOString(),
    });
    const followUpTurn = store.updateTurn(createdFollowUpTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: 'ui_follow_up',
        itemId: followUpItem.id,
      },
    });
    const followUpBody = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: followUpTurn.id,
      requestId: '0190f4c8-0000-7000-8000-000000000510',
      input: 'Continue',
    };
    const followUpFirst = await interactiveApp.request('/api/turns', {
      method: 'POST',
      body: JSON.stringify(followUpBody),
      headers: jsonHeaders(),
    });
    const followUpSecond = await interactiveApp.request('/api/turns', {
      method: 'POST',
      body: JSON.stringify(followUpBody),
      headers: jsonHeaders(),
    });

    expect((await followUpFirst.json()) as { id: string }).toMatchObject({ id: followUpTurn.id });
    expect((await followUpSecond.json()) as { id: string }).toMatchObject({ id: followUpTurn.id });
    expect(interactiveExecutor.userInputResponses).toBe(1);

    const interruptTurn = store.createTurn('ws_demo', 'th_demo', 'Interrupt once');
    const interruptBody = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: interruptTurn.id,
      requestId: '0190f4c8-0000-7000-8000-000000000511',
    };
    const interruptPath = `/api/workspaces/ws_demo/threads/th_demo/turns/${interruptTurn.id}/interrupt`;
    const interruptFirst = await interactiveApp.request(interruptPath, {
      method: 'POST',
      body: JSON.stringify(interruptBody),
      headers: jsonHeaders(),
    });
    const interruptSecond = await interactiveApp.request(interruptPath, {
      method: 'POST',
      body: JSON.stringify(interruptBody),
      headers: jsonHeaders(),
    });

    expect((await interruptFirst.json()) as { id: string; status: string }).toMatchObject({
      id: interruptTurn.id,
      status: 'interrupted',
    });
    expect((await interruptSecond.json()) as { id: string; status: string }).toMatchObject({
      id: interruptTurn.id,
      status: 'interrupted',
    });
    expect(interactiveExecutor.interrupts).toBe(1);

    const approvalExecutor = new ApprovalTurnExecutor();
    const approvalApp = createApp({ store, turnExecutor: approvalExecutor });
    const approvalTurn = store.createTurn('ws_demo', 'th_demo', 'Approve once');
    store.createApproval({
      id: 'ap_idempotent',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve',
      description: 'Approve once.',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    const approvalBody = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: approvalTurn.id,
      requestId: '0190f4c8-0000-7000-8000-000000000512',
      decision: 'granted',
    };
    const approvalFirst = await approvalApp.request('/api/approvals/ap_idempotent/respond', {
      method: 'POST',
      body: JSON.stringify(approvalBody),
      headers: jsonHeaders(),
    });
    const approvalSecond = await approvalApp.request('/api/approvals/ap_idempotent/respond', {
      method: 'POST',
      body: JSON.stringify(approvalBody),
      headers: jsonHeaders(),
    });

    expect((await approvalFirst.json()) as { id: string; status: string }).toMatchObject({
      id: 'ap_idempotent',
      status: 'granted',
    });
    expect((await approvalSecond.json()) as { id: string; status: string }).toMatchObject({
      id: 'ap_idempotent',
      status: 'granted',
    });
    expect(approvalExecutor.approvalResponses).toBe(1);
  });

  it('rejects turn input submissions while the turn waits on approval', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new InteractiveTurnExecutor() });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Await approval');
    const approvalItem = store.createItem({
      id: 'it_approval_gate',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: 'ap_gate',
      title: 'Approve',
      description: 'Approval is required before user input can resume the turn.',
      kind: 'permission',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    store.updateTurn(turn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: 'ap_gate',
        itemId: approvalItem.id,
      },
    });

    const res = await app.request('/api/turns', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        requestId: '0190f4c8-0000-7000-8000-000000000513',
        input: 'This should not answer an approval.',
      }),
      headers: jsonHeaders(),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'turn_not_awaiting_user_input',
    });

    const implicit = await app.request('/api/turns', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: '0190f4c8-0000-7000-8000-000000000514',
        input: 'This must not become implicit steering.',
      }),
      headers: jsonHeaders(),
    });

    expect(implicit.status).toBe(409);
    await expect(implicit.json()).resolves.toMatchObject({ code: 'thread_busy' });
  });

  it('returns an idempotency conflict for the same request id with different input', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const requestId = '0190f4c8-0000-7000-8000-000000000513';
    const first = await app.request('/api/workspaces/ws_demo/threads', {
      method: 'POST',
      body: JSON.stringify({ requestId, name: 'Conflict A' }),
      headers: jsonHeaders(),
    });
    const conflict = await app.request('/api/workspaces/ws_demo/threads', {
      method: 'POST',
      body: JSON.stringify({ requestId, name: 'Conflict B' }),
      headers: jsonHeaders(),
    });

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'idempotency_key_conflict',
    });
  });

  it('returns invalid_request for missing request ids on all protocol mutating routes', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new ApprovalTurnExecutor() });
    const turn = store.updateTurn(store.createTurn('ws_demo', 'th_demo', 'Need input').id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: 'ap_missing_request',
        itemId: 'it_missing_request_approval',
      },
    });
    store.createApproval({
      id: 'ap_missing_request',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve',
      description: 'Missing request id.',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });

    const cases = [
      app.request('/api/workspaces/ws_demo', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Missing request id' }),
        headers: jsonHeaders(),
      }),
      app.request('/api/workspaces/ws_demo/knowledge', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'preference',
          title: 'Missing request id',
          content: 'Should fail.',
        }),
        headers: jsonHeaders(),
      }),
      app.request('/api/workspaces/ws_demo/knowledge/mem_project', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Missing request id' }),
        headers: jsonHeaders(),
      }),
      app.request('/api/workspaces/ws_demo/knowledge/mem_project', {
        method: 'DELETE',
        body: JSON.stringify({}),
        headers: jsonHeaders(),
      }),
      app.request('/api/workspaces/ws_demo/threads', {
        method: 'POST',
        body: JSON.stringify({ name: 'Missing request id' }),
        headers: jsonHeaders(),
      }),
      app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: 'Missing request id',
        }),
        headers: jsonHeaders(),
      }),
      app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          input: 'Missing request id',
        }),
        headers: jsonHeaders(),
      }),
      app.request('/api/approvals/ap_missing_request/respond', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          decision: 'granted',
        }),
        headers: jsonHeaders(),
      }),
    ];

    for (const responsePromise of cases) {
      const response = await responsePromise;

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining('requestId'),
      });
    }
  });

  it('updates and archives threads with request-correlated command schemas', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });

    const missingRequestId = await app.request('/api/workspaces/ws_demo/threads/th_demo', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Missing request id' }),
      headers: { 'content-type': 'application/json' },
    });
    const updateRes = await app.request('/api/workspaces/ws_demo/threads/th_demo', {
      method: 'PATCH',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000208',
        name: 'Protocol hardening',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const archiveRes = await app.request('/api/workspaces/ws_demo/threads/th_demo/archive', {
      method: 'POST',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000209',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(missingRequestId.status).toBe(400);
    await expect(missingRequestId.json()).resolves.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('requestId'),
    });
    expect(ThreadSchema.parse(await updateRes.json())).toMatchObject({
      name: 'Protocol hardening',
      status: 'active',
    });
    expect(ThreadSchema.parse(await archiveRes.json())).toMatchObject({
      name: 'Protocol hardening',
      status: 'archived',
    });
  });

  it('updates artifact metadata with request-correlated command schemas', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() });
    const timestamp = new Date().toISOString();
    store.createArtifact({
      id: 'ar_server_test',
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      kind: 'summary',
      title: 'Draft summary',
      status: 'draft',
      summary: null,
      version: 1,
      content: { format: 'markdown', body: '# Draft' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const missingRequestId = await app.request('/api/workspaces/ws_demo/artifacts/ar_server_test', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Missing request id' }),
      headers: { 'content-type': 'application/json' },
    });
    const updateRes = await app.request('/api/workspaces/ws_demo/artifacts/ar_server_test', {
      method: 'PATCH',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000210',
        title: 'Ready summary',
        status: 'ready',
        summary: 'Updated through the Core artifact metadata command.',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(missingRequestId.status).toBe(400);
    await expect(missingRequestId.json()).resolves.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('requestId'),
    });
    expect(updateRes.status).toBe(200);
    await expect(updateRes.json()).resolves.toMatchObject({
      id: 'ar_server_test',
      title: 'Ready summary',
      status: 'ready',
      summary: 'Updated through the Core artifact metadata command.',
    });
  });

  it('does not update an artifact through a different workspace path', async () => {
    const store = createDemoStore();
    const otherWorkspace = store.createWorkspace('Other artifact workspace');
    const timestamp = new Date().toISOString();
    store.createArtifact({
      id: 'ar_other_workspace',
      workspaceId: otherWorkspace.id,
      threadId: null,
      turnId: null,
      kind: 'summary',
      title: 'Other workspace artifact',
      status: 'draft',
      summary: null,
      version: 1,
      content: { format: 'markdown', body: '# Other workspace' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() });

    const response = await app.request('/api/workspaces/ws_demo/artifacts/ar_other_workspace', {
      method: 'PATCH',
      body: JSON.stringify({
        requestId: '0190f4c8-0000-7000-8000-000000000210',
        title: 'Cross-workspace mutation',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(404);
    expect(store.getArtifact(otherWorkspace.id, 'ar_other_workspace').title).toBe(
      'Other workspace artifact'
    );
  });

  it('lists and reads workspace synchronization reviews from review artifacts', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    store.createTurn('ws_demo', 'th_demo', 'Produce workspace review', null, {
      turnId: 'turn_demo',
    });
    const timestamp = new Date().toISOString();
    const patchText = 'diff --git a/docs/spec.md b/docs/spec.md\n';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
    const workspaceReview = {
      changeSet: {
        id: 'wcs_1',
        materializationRecordId: 'wmr_1',
        inputSnapshotId: 'wis_1',
        workspaceId: 'ws_demo',
        resourceId: 'default',
        strategy: 'git',
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
        patch: {
          ref: 'artifact://patch',
          digest: patchDigest,
          bytes: Buffer.byteLength(patchText, 'utf8'),
        },
        bundle: null,
        artifactIds: ['ar_workspace_changes_1'],
        evidenceRefs: [{ kind: 'worker', ref: 'turn_demo' }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: timestamp,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest: patchDigest,
        bytes: Buffer.byteLength(patchText, 'utf8'),
      },
      review: {
        id: 'swr_1',
        changeSetId: 'wcs_1',
        workspaceId: 'ws_demo',
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: 'staging://workspace/wcs_1',
          branch: 'openkit/review/swr_1',
        },
        diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
        riskSummary: '1 changed path staged for human review.',
        validation: [{ command: 'worker', status: 'passed', ref: 'turn_demo' }],
        actionCenterRowId: 'workspace-review:swr_1',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    store.createArtifact({
      id: 'ar_workspace_changes_1',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: workspaceReview.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(workspaceReview) },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.createArtifact({
      id: 'ar_regular_report',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'report',
      title: 'Regular report',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'markdown', body: '# Report' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      const item = { artifactId: 'ar_workspace_changes_1', ...workspaceReview };
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, {
        item,
      });
    } finally {
      workspaceDb.sqlite.close();
    }

    const list = await app.request('/api/app/workspaces/ws_demo/workspace-sync/reviews');
    const detail = await app.request('/api/app/workspaces/ws_demo/workspace-sync/reviews/swr_1');
    const inputSnapshots = await app.request(
      '/api/app/workspaces/ws_demo/workspace-sync/input-snapshots'
    );
    const materializations = await app.request(
      '/api/app/workspaces/ws_demo/workspace-sync/materialization-records'
    );
    const backendHandles = await app.request(
      '/api/app/workspaces/ws_demo/workspace-sync/backend-handles'
    );
    const outputManifests = await app.request(
      '/api/app/workspaces/ws_demo/workspace-sync/output-manifests'
    );
    const changeSets = await app.request('/api/app/workspaces/ws_demo/workspace-sync/change-sets');
    const stagedReviews = await app.request(
      '/api/app/workspaces/ws_demo/workspace-sync/staged-reviews'
    );
    const restartedApp = createApp({
      coreDb,
      store: createDemoStore(),
      turnExecutor: new FakeTurnExecutor(),
    });
    const persistedDetail = await restartedApp.request(
      '/api/app/workspaces/ws_demo/workspace-sync/reviews/swr_1'
    );

    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ artifactId: 'ar_workspace_changes_1', review: { id: 'swr_1' } }],
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      artifactId: 'ar_workspace_changes_1',
      changeSet: { changedPaths: [{ path: 'docs/spec.md' }] },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: expect.stringContaining('diff --git a/docs/spec.md b/docs/spec.md'),
      },
      review: { id: 'swr_1' },
    });
    expect(inputSnapshots.status).toBe(200);
    await expect(inputSnapshots.json()).resolves.toMatchObject({
      items: [{ id: 'wis_1', resourceId: 'default', strategy: 'git' }],
    });
    expect(materializations.status).toBe(200);
    await expect(materializations.json()).resolves.toMatchObject({
      items: [{ id: 'wmr_1', inputSnapshotId: 'wis_1', strategy: 'git' }],
    });
    expect(backendHandles.status).toBe(200);
    await expect(backendHandles.json()).resolves.toMatchObject({
      items: [{ id: 'bwh_wmr_1', materializationRecordId: 'wmr_1', backendKind: 'openshell' }],
    });
    expect(outputManifests.status).toBe(200);
    await expect(outputManifests.json()).resolves.toMatchObject({
      items: [{ id: 'wom_wcs_1', materializationRecordId: 'wmr_1', strategy: 'git' }],
    });
    expect(changeSets.status).toBe(200);
    await expect(changeSets.json()).resolves.toMatchObject({
      items: [{ id: 'wcs_1', changedPaths: [{ path: 'docs/spec.md' }] }],
    });
    expect(stagedReviews.status).toBe(200);
    await expect(stagedReviews.json()).resolves.toMatchObject({
      items: [{ id: 'swr_1', changeSetId: 'wcs_1' }],
    });
    expect(persistedDetail.status).toBe(200);
    await expect(persistedDetail.json()).resolves.toMatchObject({
      artifactId: 'ar_workspace_changes_1',
      review: { id: 'swr_1' },
    });
  });

  it('keeps artifact-only workspace review reads free of durable side effects', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const item = workspaceSyncReviewRouteItem();
    store.createTurn('ws_demo', 'th_demo', 'Produce artifact-only workspace review', null, {
      turnId: 'turn_demo',
    });

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    const observerDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const beforeDataVersion = (
      observerDb.sqlite.prepare('PRAGMA data_version').get() as { data_version: number }
    ).data_version;

    try {
      const list = await app.request('/api/app/workspaces/ws_demo/workspace-sync/reviews');
      const detail = await app.request(
        '/api/app/workspaces/ws_demo/workspace-sync/reviews/swr_route_1'
      );
      const afterDataVersion = (
        observerDb.sqlite.prepare('PRAGMA data_version').get() as { data_version: number }
      ).data_version;

      expect(getWorkspaceSyncReview(observerDb, 'ws_demo', 'swr_route_1')).toBeNull();
      expect(afterDataVersion).toBe(beforeDataVersion);

      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        items: [{ review: { id: 'swr_route_1', status: 'pending' } }],
      });
      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        review: { id: 'swr_route_1', status: 'pending' },
      });
    } finally {
      observerDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('routes workspace artifact refinement through the durable review lifecycle', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const item = workspaceSyncReviewRouteItem();

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: null,
      turnId: null,
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    const workspaceDb = openTestWorkspaceDb(coreDb, item.review.workspaceId);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
    } finally {
      workspaceDb.sqlite.close();
    }

    try {
      const response = await app.request(
        `/api/app/workspaces/${item.review.workspaceId}/artifacts/${item.artifactId}/review`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'workspace-artifact-refinement-1',
            decision: 'needs_refinement',
            message: 'Narrow the workspace patch.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );
      const body = (await response.json()) as { review: { decidedAt: string; status: string } };
      const actionCenter = await app.request(
        `/api/app/workspaces/${item.review.workspaceId}/action-center`
      );
      const persistedDb = openTestWorkspaceDb(coreDb, item.review.workspaceId);
      try {
        const durableReview = getWorkspaceSyncReview(
          persistedDb,
          item.review.workspaceId,
          item.review.id
        );
        const decisionEvents = listWorkspaceAuditEvents(
          persistedDb,
          item.review.workspaceId
        ).filter((event) => event.action === 'workspace.review.decide');

        expect(response.status).toBe(200);
        expect(body.review.status).toBe('needs_refinement');
        expect(durableReview?.review).toMatchObject({ status: 'pending' });
        expect(decisionEvents).toHaveLength(0);
        expect(listWorkspaceApplyPlans(persistedDb, item.review.workspaceId)).toEqual([]);
        expect(listWorkspaceApplyResults(persistedDb, item.review.workspaceId)).toEqual([]);
      } finally {
        persistedDb.sqlite.close();
      }
      expect(
        ListHumanAttentionResponseSchema.parse(await actionCenter.json()).items.some(
          (row) => row.id === item.review.actionCenterRowId
        )
      ).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('prefers durable workspace review decisions over older artifact snapshots', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const item = workspaceSyncReviewRouteItem();
    store.createTurn('ws_demo', 'th_demo', 'Produce durable workspace review', null, {
      turnId: 'turn_demo',
    });

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: 'th_demo',
      turnId: 'turn_demo',
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
      try {
        recordTestWorkspaceReviewMaterialization(workspaceDb, item);
        recordWorkspaceSyncReview(workspaceDb, { item });
        updateWorkspaceSyncReviewDecision(workspaceDb, {
          requestId: 'durable-review-read-precedence',
          reviewId: item.review.id,
          status: 'needs_refinement',
          updatedAt: '2026-07-06T00:01:00.000Z',
          workspaceId: item.review.workspaceId,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const list = await app.request('/api/app/workspaces/ws_demo/workspace-sync/reviews');
      const detail = await app.request(
        '/api/app/workspaces/ws_demo/workspace-sync/reviews/swr_route_1'
      );

      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        items: [{ review: { id: 'swr_route_1', status: 'needs_refinement' } }],
      });
      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        review: { id: 'swr_route_1', status: 'needs_refinement' },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records durable workspace synchronization review decisions idempotently', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const workspace = store.createWorkspace('Durable workspace review decision');
    const timestamp = new Date().toISOString();
    const patchText = 'diff --git a/docs/decision.md b/docs/decision.md\n';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
    const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
      artifactId: 'ar_missing_workspace_review_decision',
      changeSet: {
        id: 'wcs_durable_review_decision',
        materializationRecordId: 'wmr_durable_review_decision',
        inputSnapshotId: 'wis_durable_review_decision',
        workspaceId: workspace.id,
        resourceId: 'repo_default',
        strategy: 'git',
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: 'docs/decision.md', status: 'modified', binary: false }],
        patch: {
          ref: 'artifact://patch',
          digest: patchDigest,
          bytes: Buffer.byteLength(patchText, 'utf8'),
        },
        bundle: null,
        artifactIds: ['ar_missing_workspace_review_decision'],
        evidenceRefs: [{ kind: 'worker', ref: 'turn_durable_review_decision' }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: timestamp,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest: patchDigest,
        bytes: Buffer.byteLength(patchText, 'utf8'),
      },
      review: {
        id: 'swr_durable_review_decision',
        changeSetId: 'wcs_durable_review_decision',
        workspaceId: workspace.id,
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: 'staging://workspace/wcs_durable_review_decision',
          branch: null,
        },
        diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
        riskSummary: '1 changed path staged for human review.',
        validation: [{ command: 'worker', status: 'passed', ref: 'turn_durable_review_decision' }],
        actionCenterRowId: 'workspace-review:swr_durable_review_decision',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordTestWorkspaceReviewMaterialization(workspaceDb, item);
        recordWorkspaceSyncReview(workspaceDb, { item });
      } finally {
        workspaceDb.sqlite.close();
      }

      const firstRes = await app.request(
        `/api/app/workspaces/${workspace.id}/workspace-sync/reviews/swr_durable_review_decision/decision`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'workspace-sync-review-request-1',
            decision: 'needs_refinement',
            message: 'Please narrow this patch.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );
      const secondRes = await app.request(
        `/api/app/workspaces/${workspace.id}/workspace-sync/reviews/swr_durable_review_decision/decision`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'workspace-sync-review-request-1',
            decision: 'needs_refinement',
            message: 'Please narrow this patch.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );
      const actionCenterRes = await app.request(
        `/api/app/workspaces/${workspace.id}/action-center`
      );
      const persistedDb = openTestWorkspaceDb(coreDb, workspace.id);
      let persistedStatus: string;
      try {
        persistedStatus =
          getWorkspaceSyncReview(persistedDb, workspace.id, 'swr_durable_review_decision')?.review
            .status ?? 'missing';
      } finally {
        persistedDb.sqlite.close();
      }

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);
      expect(await secondRes.json()).toEqual(await firstRes.json());
      expect(persistedStatus).toBe('needs_refinement');
      expect(
        ListHumanAttentionResponseSchema.parse(await actionCenterRes.json()).items.some(
          (row) => row.id === 'workspace-review:swr_durable_review_decision'
        )
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records workspace recovery decisions idempotently', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const workspace = store.createWorkspace('Workspace recovery decision');
    const timestamp = new Date().toISOString();

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordWorkspaceReconciliationRecord(workspaceDb, {
          id: 'wrr_recovery_decision',
          workspaceId: workspace.id,
          triggerReason: 'restart',
          affectedRecordIds: ['wmr_recovery_decision', 'bwh_recovery_decision'],
          backendHandleSummary: {
            backendKind: 'openshell',
            handleId: 'bwh_recovery_decision',
            workerSessionId: 'session_recovery_decision',
            cleanupStatus: 'pending',
          },
          backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
          collectedOutputManifestIds: ['wom_recovery_decision'],
          evidenceBundleIds: ['evb_recovery_decision'],
          stateBefore: 'ready',
          stateAfter: 'requires-human',
          quarantineRefs: [],
          requiredHumanDecision: 'inspect_recovery',
          retentionDecision: 'retain-backend',
          startedAt: timestamp,
          finishedAt: null,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const href = `/api/app/workspaces/${workspace.id}/workspace-sync/reconciliation-records/wrr_recovery_decision/decision`;
      const firstRes = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-recovery-request-1',
          decision: 'quarantine',
          message: 'Keep unsafe recovery material isolated.',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const secondRes = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-recovery-request-1',
          decision: 'quarantine',
          message: 'Keep unsafe recovery material isolated.',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const actionCenterRes = await app.request(
        `/api/app/workspaces/${workspace.id}/action-center`
      );

      const firstPayload = await firstRes.json();
      const secondPayload = await secondRes.json();

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);
      expect(secondPayload).toEqual(firstPayload);
      expect(
        SubmitWorkspaceRecoveryDecisionResponseSchema.parse(firstPayload).reconciliationRecord
      ).toMatchObject({
        id: 'wrr_recovery_decision',
        stateBefore: 'requires-human',
        stateAfter: 'quarantined',
        requiredHumanDecision: null,
        retentionDecision: 'teardown-backend',
      });
      expect(
        ListHumanAttentionResponseSchema.parse(await actionCenterRes.json()).items.some(
          (row) => row.id === 'workspace-recovery:wrr_recovery_decision'
        )
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('resumes workspace recovery collection from durable workspace sync records', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const workspace = store.createWorkspace('Workspace recovery resume');
    const timestamp = new Date().toISOString();
    const routeItem = workspaceSyncReviewRouteItem();
    const item: Parameters<typeof recordWorkspaceSyncReview>[1]['item'] = {
      ...routeItem,
      changeSet: {
        ...routeItem.changeSet,
        id: 'wcs_resume_route',
        inputSnapshotId: 'wis_resume_route',
        materializationRecordId: 'wmr_resume_route',
        workspaceId: workspace.id,
      },
      review: {
        ...routeItem.review,
        actionCenterRowId: 'workspace-review:swr_resume_route',
        changeSetId: 'wcs_resume_route',
        id: 'swr_resume_route',
        workspaceId: workspace.id,
      },
    };

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordTestWorkspaceReviewMaterialization(workspaceDb, item);
        recordWorkspaceSyncReview(workspaceDb, { item });
        recordWorkspaceReconciliationRecord(workspaceDb, {
          id: 'wrr_resume_route',
          workspaceId: workspace.id,
          triggerReason: 'backend_takeover',
          affectedRecordIds: ['wmr_resume_route', 'bwh_resume_route'],
          backendHandleSummary: {
            backendKind: 'openshell',
            cleanupStatus: 'pending',
            handleId: 'bwh_resume_route',
            workerSessionId: 'session_resume_route',
          },
          backendReachability: {
            status: 'unavailable',
            checkedAt: timestamp,
            detail: 'lease stale',
          },
          collectedOutputManifestIds: [],
          evidenceBundleIds: [
            'evb_workspace_materialization_wmr_resume_route',
            'evb_workspace_review_swr_resume_route',
          ],
          stateBefore: 'lease-stale',
          stateAfter: 'requires-human',
          quarantineRefs: [],
          requiredHumanDecision: 'inspect_recovery',
          retentionDecision: 'retain-backend',
          startedAt: timestamp,
          finishedAt: null,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const res = await app.request(
        `/api/app/workspaces/${workspace.id}/workspace-sync/reconciliation-records/wrr_resume_route/decision`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'workspace-recovery-resume-request-1',
            decision: 'resume_collection',
            message: 'Resume durable collection.',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(res.status, await res.clone().text()).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        reconciliationRecord: {
          id: 'wrr_resume_route',
          stateBefore: 'requires-human',
          stateAfter: 'recovered',
          collectedOutputManifestIds: ['wom_wcs_resume_route'],
          evidenceBundleIds: [
            'evb_workspace_materialization_wmr_resume_route',
            'evb_workspace_review_swr_resume_route',
          ],
          requiredHumanDecision: null,
          retentionDecision: 'teardown-backend',
        },
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reads durable Agent Environment Package snapshots through App API routes', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const workspace = store.createWorkspace('AEP snapshot readback');
    const createdAt = '2026-07-06T00:00:01.000Z';
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent: {
          id: 'agent_codex_host',
          name: 'Codex Agent',
          kind: 'coder',
          status: 'enabled',
          modelId: null,
          skillIds: [],
          profiles: [
            {
              id: 'default',
              displayName: 'Default',
              instructionsRef: null,
              modelId: null,
              skillIds: [],
              capabilityIds: [],
            },
          ],
          defaultProfileId: 'default',
          capabilities: [],
          sandboxSummary: null,
          config: {
            adapterType: 'codex',
            command: null,
            baseUrl: null,
            workspaceRoot: '/workspace',
            environment: { OPENAI_API_KEY: 'sk-redacted-before-response' },
            capabilities: [],
          },
        },
        agentSessionId: 'as_aep_readback',
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'openkit/worker-codex:dev',
        },
        requestId: 'req_aep_readback',
        turn: {
          id: 'turn_aep_readback',
          workspaceId: workspace.id,
          threadId: 'th_aep_readback',
          items: [],
          status: 'running',
          humanGate: null,
          error: null,
          configVersion: null,
          startedAt: '2026-07-06T00:00:00.000Z',
          completedAt: null,
          durationMs: null,
        },
        turnInput: 'Run tests',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      })
    );

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordAgentEnvironmentPackageSnapshot(workspaceDb, { createdAt, environmentPackage });
      } finally {
        workspaceDb.sqlite.close();
      }

      const list = await app.request(
        `/api/app/workspaces/${workspace.id}/agent-environment/snapshots`
      );
      const detail = await app.request(
        `/api/app/workspaces/${workspace.id}/agent-environment/snapshots/${environmentPackage.snapshotId}`
      );
      const missing = await app.request(
        `/api/app/workspaces/${workspace.id}/agent-environment/snapshots/missing`
      );

      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        items: [
          {
            snapshotId: environmentPackage.snapshotId,
            workspaceId: workspace.id,
            turnId: 'turn_aep_readback',
            agentSessionId: 'as_aep_readback',
            backendKind: 'openshell',
          },
        ],
      });
      expect(detail.status).toBe(200);
      const detailJson = await detail.json();
      expect(detailJson).toMatchObject({
        snapshotId: environmentPackage.snapshotId,
        snapshot: { snapshotId: environmentPackage.snapshotId },
      });
      expect(JSON.stringify(detailJson)).not.toContain('sk-redacted-before-response');
      expect(missing.status).toBe(404);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records artifact review decisions idempotently', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-artifact-review-repository-'));
    const thread = store.createThread('ws_demo', 'Artifact review idempotency');
    const timestamp = new Date().toISOString();
    const sourceTurn = store.updateTurn(
      store.createTurn('ws_demo', thread.id, 'Produce artifact').id,
      {
        agentId: 'agent_codex_host',
        status: 'completed',
        completedAt: timestamp,
      }
    );
    const blockingTurn = store.updateTurn(
      store.createTurn('ws_demo', thread.id, 'Keep unrelated work active').id,
      { agentId: 'agent_codex_host', status: 'running' }
    );
    store.createArtifact({
      id: 'artifact_review_idempotent',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: sourceTurn.id,
      kind: 'summary',
      title: 'Review summary',
      status: 'ready',
      summary: 'Ready for human review.',
      version: 1,
      content: { format: 'markdown', body: '# Review summary' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    mkdirSync(join(repositoryPath, '.git'));
    const repository = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
      method: 'PUT',
      body: JSON.stringify({
        displayName: 'Artifact review repository',
        localPath: repositoryPath,
      }),
      headers: { 'content-type': 'application/json' },
    });

    const busyRes = await app.request(
      '/api/app/workspaces/ws_demo/artifacts/artifact_review_idempotent/review',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'artifact-review-request-1',
          decision: 'needs_refinement',
          message: 'Tighten the summary.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(busyRes.status).toBe(409);
    await expect(busyRes.json()).resolves.toMatchObject({ code: 'thread_busy' });
    expect(store.getArtifactReviewDecision('artifact_review_idempotent')).toBeNull();
    expect(
      store.listCommandRequests().filter((record) => record.command === 'artifact.review.decide')
    ).toEqual([]);
    expect(store.listThreadTurns('ws_demo', thread.id).map((turn) => turn.id)).toEqual([
      sourceTurn.id,
      blockingTurn.id,
    ]);
    expect(executor.startContexts).toHaveLength(0);
    store.updateTurn(blockingTurn.id, { status: 'completed', completedAt: timestamp });

    const firstRes = await app.request(
      '/api/app/workspaces/ws_demo/artifacts/artifact_review_idempotent/review',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'artifact-review-request-1',
          decision: 'needs_refinement',
          message: 'Tighten the summary.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const secondRes = await app.request(
      '/api/app/workspaces/ws_demo/artifacts/artifact_review_idempotent/review',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'artifact-review-request-1',
          decision: 'needs_refinement',
          message: 'Tighten the summary.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const conflictRes = await app.request(
      '/api/app/workspaces/ws_demo/artifacts/artifact_review_idempotent/review',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'artifact-review-request-1',
          decision: 'redo',
          message: 'Redo the summary.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const replacementRequestRes = await app.request(
      '/api/app/workspaces/ws_demo/artifacts/artifact_review_idempotent/review',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'artifact-review-request-2',
          decision: 'redo',
          message: 'Redo the summary.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(firstRes.status, await firstRes.clone().text()).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual(await firstRes.json());
    expect(replacementRequestRes.status).toBe(409);
    await expect(replacementRequestRes.json()).resolves.toMatchObject({
      code: 'idempotency_key_conflict',
    });
    expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(3);
    const followUpTurn = store
      .listThreadTurns('ws_demo', thread.id)
      .find((turn) => turn.id !== sourceTurn.id && turn.id !== blockingTurn.id);
    expect(repository.status).toBe(200);
    expect(executor.startContexts).toHaveLength(1);
    expect(followUpTurn).toMatchObject({
      agentId: sourceTurn.agentId,
      status: 'completed',
    });
    expect(followUpTurn?.items.map((item) => item.type)).toEqual([
      'user-message',
      'assistant-message',
    ]);
    expect(store.getArtifactReviewDecision('artifact_review_idempotent')).toMatchObject({
      status: 'needs_refinement',
      requestId: 'artifact-review-request-1',
    });
    expect(conflictRes.status).toBe(409);
    await expect(conflictRes.json()).resolves.toMatchObject({
      code: 'idempotency_key_conflict',
    });
    coreDb.sqlite.close();
  });

  it('serializes competing workspace artifact review decisions before creating follow-ups', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();
    const thread = store.createThread('ws_demo', 'Concurrent workspace artifact review');
    const createdSourceTurn = store.createTurn('ws_demo', thread.id, 'Produce workspace changes');
    const sourceTurn = store.updateTurn(createdSourceTurn.id, {
      agentId: 'agent_codex_host',
      status: 'completed',
      completedAt: createdSourceTurn.startedAt,
    });
    const item = workspaceSyncReviewRouteItem();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-concurrent-review-repository-'));

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: thread.id,
      turnId: sourceTurn.id,
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    const workspaceDb = openTestWorkspaceDb(coreDb, item.review.workspaceId);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
    } finally {
      workspaceDb.sqlite.close();
    }
    mkdirSync(join(repositoryPath, '.git'));
    const repository = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
      method: 'PUT',
      body: JSON.stringify({
        displayName: 'Concurrent review repository',
        localPath: repositoryPath,
      }),
      headers: jsonHeaders(),
    });

    try {
      const href = `/api/app/workspaces/ws_demo/artifacts/${item.artifactId}/review`;
      const [first, second] = await Promise.all([
        app.request(href, {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'workspace-artifact-concurrent-1',
            decision: 'needs_refinement',
            message: 'Narrow the workspace patch.',
          }),
          headers: jsonHeaders(),
        }),
        app.request(href, {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'workspace-artifact-concurrent-2',
            decision: 'redo',
            message: 'Redo the workspace patch.',
          }),
          headers: jsonHeaders(),
        }),
      ]);
      const followUpTurns = store
        .listThreadTurns('ws_demo', thread.id)
        .filter((turn) => turn.id !== sourceTurn.id);
      const followUpItems = store
        .listThreadItems('ws_demo', thread.id)
        .filter((candidate) => candidate.turnId !== sourceTurn.id);

      expect(repository.status).toBe(200);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      expect(executor.startContexts).toHaveLength(1);
      expect(followUpTurns).toHaveLength(1);
      expect(followUpItems).toHaveLength(2);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('recovers an incomplete workspace artifact review through a fresh file-backed app', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-review-restart-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Restarted workspace artifact review');
    const createdSourceTurn = store.createTurn('ws_demo', thread.id, 'Produce workspace changes');
    const sourceTurn = store.updateTurn(createdSourceTurn.id, {
      agentId: 'agent_codex_host',
      status: 'completed',
      completedAt: createdSourceTurn.startedAt,
    });
    const item = workspaceSyncReviewRouteItem();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-restarted-review-repository-'));
    let restartedCoreDb: CoreDb | null = null;

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: thread.id,
      turnId: sourceTurn.id,
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    const workspaceDb = openTestWorkspaceDb(coreDb, item.review.workspaceId);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
    } finally {
      workspaceDb.sqlite.close();
    }
    mkdirSync(join(repositoryPath, '.git'));
    await app.request('/api/app/workspaces/ws_demo/repositories/default', {
      method: 'PUT',
      body: JSON.stringify({
        displayName: 'Restarted review repository',
        localPath: repositoryPath,
      }),
      headers: jsonHeaders(),
    });
    const recordArtifactReviewDecision = store.recordArtifactReviewDecision.bind(store);
    vi.spyOn(store, 'recordArtifactReviewDecision').mockImplementation((review) => {
      if (review.lifecycle === 'completed') {
        throw new Error('Injected artifact decision persistence failure.');
      }
      return recordArtifactReviewDecision(review);
    });

    try {
      const href = `/api/app/workspaces/ws_demo/artifacts/${item.artifactId}/review`;
      const request = {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-artifact-restart-recovery',
          decision: 'needs_refinement',
          message: 'Narrow the workspace patch.',
        }),
        headers: jsonHeaders(),
      };
      const first = await app.request(href, request);
      const restartedStore = createDemoStore({ dataRoot });
      restartedCoreDb = openCoreDb(dataRoot);
      applyMigrations(restartedCoreDb);
      const restartedApp = createApp({
        coreDb: restartedCoreDb,
        store: restartedStore,
        turnExecutor: new FakeTurnExecutor(),
      });
      const retry = await restartedApp.request(href, request);
      const followUpTurns = restartedStore
        .listThreadTurns('ws_demo', thread.id)
        .filter((turn) => turn.id !== sourceTurn.id);
      const followUpItems = restartedStore
        .listThreadItems('ws_demo', thread.id)
        .filter((candidate) => candidate.turnId !== sourceTurn.id);

      expect(retry.status).toBe(200);
      expect(followUpTurns).toHaveLength(1);
      expect(followUpItems).toHaveLength(2);
      expect(restartedStore.getArtifactReviewDecision(item.artifactId)).toMatchObject({
        requestId: 'workspace-artifact-restart-recovery',
        status: 'needs_refinement',
        followUpTurnId: followUpTurns[0]?.id,
      });
      expect(first.status).toBe(500);
    } finally {
      restartedCoreDb?.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps workspace decisions separate from artifact refinement', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Cross-route workspace artifact review');
    const createdSourceTurn = store.createTurn('ws_demo', thread.id, 'Produce workspace changes');
    const sourceTurn = store.updateTurn(createdSourceTurn.id, {
      agentId: 'agent_codex_host',
      status: 'completed',
      completedAt: createdSourceTurn.startedAt,
    });
    const item = workspaceSyncReviewRouteItem();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-separated-review-repository-'));

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: thread.id,
      turnId: sourceTurn.id,
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    const workspaceDb = openTestWorkspaceDb(coreDb, item.review.workspaceId);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
      mkdirSync(join(repositoryPath, '.git'));
      upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        workspaceId: 'ws_demo',
        displayName: 'Separated review repository',
        localPath: repositoryPath,
      });
    } finally {
      workspaceDb.sqlite.close();
    }

    try {
      const dedicated = await app.request(
        `/api/app/workspaces/ws_demo/workspace-sync/reviews/${item.review.id}/decision`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'workspace-dedicated-rejection',
            decision: 'rejected',
          }),
          headers: jsonHeaders(),
        }
      );
      const refinementInput = {
        requestId: 'workspace-generic-refinement',
        decision: 'needs_refinement' as const,
        message: 'Refine instead.',
      };
      const refinement = await app.request(
        `/api/app/workspaces/ws_demo/artifacts/${item.artifactId}/review`,
        {
          method: 'POST',
          body: JSON.stringify(refinementInput),
          headers: jsonHeaders(),
        }
      );

      expect(dedicated.status).toBe(200);
      expect(refinement.status, await refinement.clone().text()).toBe(200);
      expect(store.getArtifactReviewDecision(item.artifactId)).toMatchObject({
        lifecycle: 'completed',
        requestId: 'workspace-generic-refinement',
        status: 'needs_refinement',
      });
      const persistedDb = openTestWorkspaceDb(coreDb, item.review.workspaceId);
      try {
        expect(getWorkspaceSyncReview(persistedDb, 'ws_demo', item.review.id)?.review.status).toBe(
          'rejected'
        );
      } finally {
        persistedDb.sqlite.close();
      }
      expect(
        store.listThreadTurns('ws_demo', thread.id).filter((turn) => turn.id !== sourceTurn.id)
      ).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('recovers a pending workspace artifact claim from its Action Center decision', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new FakeTurnExecutor();
    const thread = store.createThread('ws_demo', 'Action Center artifact review recovery');
    const createdSourceTurn = store.createTurn('ws_demo', thread.id, 'Produce workspace changes');
    const sourceTurn = store.updateTurn(createdSourceTurn.id, {
      agentId: 'agent_codex_host',
      status: 'completed',
      completedAt: createdSourceTurn.startedAt,
    });
    const item = workspaceSyncReviewRouteItem();
    const app = createApp({ coreDb, store, turnExecutor: executor });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-action-center-review-repository-'));

    store.createArtifact({
      id: item.artifactId,
      workspaceId: item.review.workspaceId,
      threadId: thread.id,
      turnId: sourceTurn.id,
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: item.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(item) },
      createdAt: item.review.createdAt,
      updatedAt: item.review.updatedAt,
    });

    const workspaceDb = openTestWorkspaceDb(coreDb, item.review.workspaceId);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, item);
      recordWorkspaceSyncReview(workspaceDb, { item });
    } finally {
      workspaceDb.sqlite.close();
    }
    mkdirSync(join(repositoryPath, '.git'));
    const repository = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
      method: 'PUT',
      body: JSON.stringify({
        displayName: 'Action Center review repository',
        localPath: repositoryPath,
      }),
      headers: jsonHeaders(),
    });
    const recordArtifactReviewDecision = store.recordArtifactReviewDecision.bind(store);
    let completionFailed = false;
    vi.spyOn(store, 'recordArtifactReviewDecision').mockImplementation((review) => {
      if (review.lifecycle === 'completed' && !completionFailed) {
        completionFailed = true;
        throw new Error('Injected artifact decision persistence failure.');
      }
      return recordArtifactReviewDecision(review);
    });

    try {
      const href = `/api/app/workspaces/ws_demo/artifacts/${item.artifactId}/review`;
      const first = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-action-center-original-claim',
          decision: 'needs_refinement',
          message: 'Narrow the workspace patch.',
        }),
        headers: jsonHeaders(),
      });
      const actionCenterResponse = await app.request('/api/app/workspaces/ws_demo/action-center');
      const actionCenter = ListHumanAttentionResponseSchema.parse(
        await actionCenterResponse.json()
      );
      const recoveryRow = actionCenter.items.find((row) => row.artifactId === item.artifactId);
      const reviewActionKinds = new Set([
        'accept_review',
        'request_refinement',
        'retry_work',
        'mark_blocked',
        'defer',
      ]);

      expect(first.status).toBe(500);
      expect(repository.status).toBe(200);
      expect(executor.startContexts).toHaveLength(1);
      expect(store.getArtifactReviewDecision(item.artifactId)).toMatchObject({
        lifecycle: 'pending',
        message: 'Narrow the workspace patch.',
        requestId: 'workspace-action-center-original-claim',
        status: 'needs_refinement',
      });
      expect(recoveryRow).toBeDefined();
      expect(
        recoveryRow?.actions
          .filter((action) => reviewActionKinds.has(action.kind) && !action.disabled)
          .map((action) => action.kind)
      ).toEqual(['request_refinement']);

      const conflictingRecovery = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-action-center-recovery',
          decision: 'needs_refinement',
        }),
        headers: jsonHeaders(),
      });

      expect(conflictingRecovery.status).toBe(409);
      await expect(conflictingRecovery.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      const recovered = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-action-center-original-claim',
          decision: 'needs_refinement',
          message: 'Narrow the workspace patch.',
        }),
        headers: jsonHeaders(),
      });

      expect(recovered.status).toBe(200);
      expect(store.getArtifactReviewDecision(item.artifactId)).toMatchObject({
        lifecycle: 'completed',
        message: 'Narrow the workspace patch.',
        requestId: 'workspace-action-center-original-claim',
        status: 'needs_refinement',
      });
      expect(
        store.listThreadTurns('ws_demo', thread.id).filter((turn) => turn.id !== sourceTurn.id)
      ).toHaveLength(1);
      expect(
        store.listThreadItems('ws_demo', thread.id).filter((item) => item.turnId !== sourceTurn.id)
      ).toHaveLength(2);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records knowledge proposal review decisions idempotently', async () => {
    const store = createDemoStore();
    const app = createApp({ store });
    store.createKnowledgeProposal({
      id: 'kp_review_idempotent',
      workspaceId: 'ws_demo',
      title: 'Review knowledge proposal',
      summary: 'Persist the review decision.',
      status: 'pending',
      createdAt: '2026-07-05T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
    });

    const firstRes = await app.request(
      '/api/app/workspaces/ws_demo/knowledge/proposals/kp_review_idempotent/decision',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'knowledge-review-request-1',
          decision: 'rejected',
          message: 'Not reusable enough.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const secondRes = await app.request(
      '/api/app/workspaces/ws_demo/knowledge/proposals/kp_review_idempotent/decision',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'knowledge-review-request-1',
          decision: 'rejected',
          message: 'Not reusable enough.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const conflictRes = await app.request(
      '/api/app/workspaces/ws_demo/knowledge/proposals/kp_review_idempotent/decision',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'knowledge-review-request-1',
          decision: 'accepted',
          message: 'Accept instead.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const actionCenterRes = await app.request('/api/app/workspaces/ws_demo/action-center');
    const reviewed = (await firstRes.json()) as {
      review: { status: string; message: string | null; requestId: string | null };
    };
    const reviewedAgain = (await secondRes.json()) as {
      review: { status: string; message: string | null; requestId: string | null };
    };
    const actionCenter = ListHumanAttentionResponseSchema.parse(await actionCenterRes.json());

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(reviewed.review).toMatchObject({
      status: 'rejected',
      message: 'Not reusable enough.',
      requestId: 'knowledge-review-request-1',
    });
    expect(reviewedAgain).toEqual(reviewed);
    expect(store.listKnowledgeProposals('ws_demo')).toEqual([
      expect.objectContaining({ id: 'kp_review_idempotent', status: 'rejected' }),
    ]);
    expect(actionCenter.items.some((row) => row.id === 'knowledge:kp_review_idempotent')).toBe(
      false
    );
    expect(conflictRes.status).toBe(409);
    await expect(conflictRes.json()).resolves.toMatchObject({
      code: 'idempotency_key_conflict',
    });
  });

  it('applies edited knowledge proposal review content to the pending proposal', async () => {
    const store = createDemoStore();
    const app = createApp({ store });
    store.createKnowledgeProposal({
      id: 'kp_review_edit',
      workspaceId: 'ws_demo',
      title: 'Original proposal title',
      summary: 'Original proposal summary.',
      status: 'pending',
      createdAt: '2026-07-05T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
    });

    const res = await app.request(
      '/api/app/workspaces/ws_demo/knowledge/proposals/kp_review_edit/decision',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'knowledge-review-edit-1',
          decision: 'edited',
          title: 'Edited proposal title',
          summary: 'Edited proposal summary.',
          message: 'Use the edited version.',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      review: {
        proposalId: 'kp_review_edit',
        status: 'edited',
        message: 'Use the edited version.',
      },
    });
    expect(store.getKnowledgeProposal('kp_review_edit')).toMatchObject({
      title: 'Edited proposal title',
      summary: 'Edited proposal summary.',
      status: 'edited',
    });
  });

  it('applies accepted workspace synchronization review patches to the linked repository', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const workspace = store.createWorkspace('Workspace sync apply');
    const thread = store.createThread(workspace.id, 'Apply workspace review');
    const turn = store.createTurn(workspace.id, thread.id, 'Produce workspace patch');
    store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
    const repoDir = mkdtempSync(join(tmpdir(), 'openkit-workspace-apply-'));
    const timestamp = new Date().toISOString();

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'repository-local@example.invalid'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Repository Local'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(repoDir, 'unrelated.txt'), 'Keep staged for the user.\n', 'utf8');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: repoDir, stdio: 'ignore' });

    const linkRes = await app.request(`/api/app/workspaces/${workspace.id}/repositories/default`, {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Apply fixture',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          commitOnApply: true,
        },
        localPath: repoDir,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const patchText =
      'diff --git a/README.md b/README.md\n' +
      'index 07968ad..d2a9336 100644\n' +
      '--- a/README.md\n' +
      '+++ b/README.md\n' +
      '@@ -1 +1,3 @@\n' +
      ' # Demo\n' +
      '+\n' +
      '+Applied by NanoCore.';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
    const workspaceReview = {
      changeSet: {
        id: 'wcs_apply_1',
        materializationRecordId: 'wmr_apply_1',
        inputSnapshotId: 'wis_apply_1',
        workspaceId: workspace.id,
        resourceId: 'repo_default',
        strategy: 'git',
        base: { commit: baseCommit, contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: 'README.md', status: 'modified', binary: false }],
        patch: {
          ref: 'worker-session://workspace.patch',
          digest: patchDigest,
          bytes: Buffer.byteLength(patchText, 'utf8'),
        },
        bundle: null,
        artifactIds: ['ar_workspace_apply_1'],
        evidenceRefs: [{ kind: 'worker', ref: turn.id }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: timestamp,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest: patchDigest,
        bytes: Buffer.byteLength(patchText, 'utf8'),
      },
      review: {
        id: 'swr_apply_1',
        changeSetId: 'wcs_apply_1',
        workspaceId: workspace.id,
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: 'staging://workspace/wcs_apply_1',
          branch: null,
        },
        diffSummary: { filesChanged: 1, additions: 2, deletions: 0 },
        riskSummary: '1 changed path staged for human review.',
        validation: [],
        actionCenterRowId: 'workspace-review:swr_apply_1',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    store.createArtifact({
      id: 'ar_workspace_apply_1',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: workspaceReview.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(workspaceReview) },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReview);
    } finally {
      workspaceDb.sqlite.close();
    }

    expect(linkRes.status).toBe(200);

    const acceptRes = await app.request(
      `/api/app/workspaces/${workspace.id}/artifacts/ar_workspace_apply_1/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-apply-request-1',
          decision: 'accepted',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(acceptRes.status, await acceptRes.clone().text()).toBe(200);
    await expect(acceptRes.json()).resolves.toMatchObject({
      workspaceApplyResult: {
        status: 'applied',
        appliedPaths: ['README.md'],
        reviewId: 'swr_apply_1',
      },
    });
    expect(readFileSync(join(repoDir, 'README.md'), 'utf8')).toBe(
      '# Demo\n\nApplied by NanoCore.\n'
    );
    const commitId = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    const commitMessage = execFileSync('git', ['log', '-1', '--format=%B'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    const commitAuthor = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    expect(commitAuthor).toBe('Approving Human <approver@example.invalid>');
    expect(commitMessage).toContain('OpenKit-Review-Id: swr_apply_1');
    expect(commitMessage).toContain(`OpenKit-Workspace-Id: ${workspace.id}`);
    expect(commitMessage).toContain(
      'Co-Authored-By: Codex Host Agent <agent_codex_host@agents.openkit.invalid>'
    );
    expect(
      execFileSync('git', ['show', '--pretty=', '--name-only', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim()
    ).toBe('README.md');
    expect(
      execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim()
    ).toBe('unrelated.txt');

    const reviewDb = openTestWorkspaceDb(coreDb, workspace.id);
    try {
      expect(getWorkspaceSyncReview(reviewDb, workspace.id, 'swr_apply_1')?.review.status).toBe(
        'accepted'
      );
    } finally {
      reviewDb.sqlite.close();
    }

    const listApplyResults = await app.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/apply-results`
    );
    const listApplyPlans = await app.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/apply-plans`
    );
    const reconciliationDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, workspace.id);
    try {
      recordWorkspaceReconciliationRecord(reconciliationDb, {
        id: 'wrr_swr_apply_1',
        workspaceId: workspace.id,
        triggerReason: 'restart',
        affectedRecordIds: ['wmr_wcs_apply_1', 'bwh_wmr_wcs_apply_1'],
        backendHandleSummary: {
          backendKind: 'openshell',
          handleId: 'bwh_wmr_wcs_apply_1',
          workerSessionId: null,
          cleanupStatus: 'pending',
        },
        backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
        collectedOutputManifestIds: [],
        evidenceBundleIds: [],
        stateBefore: 'ready',
        stateAfter: 'requires-human',
        quarantineRefs: [],
        requiredHumanDecision: 'inspect_recovery',
        retentionDecision: 'retain-backend',
        startedAt: timestamp,
        finishedAt: null,
      });
      recordWorkspaceQuarantineRecord(reconciliationDb, {
        id: 'wqr_swr_apply_1',
        workspaceId: workspace.id,
        lifecycleRecordIds: ['wrr_swr_apply_1', 'wom_wcs_apply_1'],
        failureKind: 'digest_mismatch',
        storageRef: 'quarantine/workspace-sync/wqr_swr_apply_1',
        retentionClass: 'restricted-evidence',
        requiredHumanDecision: 'inspect_quarantined_output',
        resolution: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
      });
    } finally {
      reconciliationDb.sqlite.close();
    }
    const listReconciliations = await app.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/reconciliation-records`
    );
    const listQuarantines = await app.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/quarantine-records`
    );
    const listSyncEvidenceBundles = await app.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/evidence-bundles`
    );
    const readApplyResult = await app.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/apply-results/war_swr_apply_1`
    );
    const restartedApp = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const persistedApplyResult = await restartedApp.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/apply-results/war_swr_apply_1`
    );

    expect(listApplyResults.status).toBe(200);
    await expect(listApplyResults.json()).resolves.toMatchObject({
      items: [
        {
          id: 'war_swr_apply_1',
          reviewId: 'swr_apply_1',
          status: 'applied',
          commitIds: [commitId],
        },
      ],
    });
    expect(listApplyPlans.status).toBe(200);
    await expect(listApplyPlans.json()).resolves.toMatchObject({
      items: [
        {
          id: 'wap_swr_apply_1',
          reviewId: 'swr_apply_1',
          changeSetId: 'wcs_apply_1',
          approvalState: 'approved',
          plannedWrites: ['README.md'],
        },
      ],
    });
    expect(listReconciliations.status).toBe(200);
    await expect(listReconciliations.json()).resolves.toMatchObject({
      items: [
        {
          id: 'wrr_swr_apply_1',
          triggerReason: 'restart',
          stateBefore: 'ready',
          stateAfter: 'requires-human',
          retentionDecision: 'retain-backend',
        },
      ],
    });
    expect(listQuarantines.status).toBe(200);
    await expect(listQuarantines.json()).resolves.toMatchObject({
      items: [
        {
          id: 'wqr_swr_apply_1',
          lifecycleRecordIds: ['wrr_swr_apply_1', 'wom_wcs_apply_1'],
          failureKind: 'digest_mismatch',
          storageRef: 'quarantine/workspace-sync/wqr_swr_apply_1',
          resolution: 'pending',
        },
      ],
    });
    expect(listSyncEvidenceBundles.status).toBe(404);
    expect(readApplyResult.status).toBe(200);
    await expect(readApplyResult.json()).resolves.toMatchObject({
      id: 'war_swr_apply_1',
      changeSetId: 'wcs_apply_1',
      appliedPaths: ['README.md'],
      commitIds: [commitId],
    });
    expect(persistedApplyResult.status).toBe(200);
    await expect(persistedApplyResult.json()).resolves.toMatchObject({
      id: 'war_swr_apply_1',
      reviewId: 'swr_apply_1',
      commitIds: [commitId],
    });
  });

  it('does not materialize workspace review branches during read requests', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const workspace = store.createWorkspace('Workspace sync review branch');
    const thread = store.createThread(workspace.id, 'Stage workspace review branch');
    const turn = store.createTurn(workspace.id, thread.id, 'Produce branch patch');
    const repoDir = mkdtempSync(join(tmpdir(), 'openkit-workspace-review-branch-'));
    const timestamp = new Date().toISOString();

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'repository-local@example.invalid'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Repository Local'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    await app.request(`/api/app/workspaces/${workspace.id}/repositories/default`, {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Review branch fixture',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          commitOnApply: true,
          stagingStrategy: 'review-branch',
        },
        localPath: repoDir,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const patchText =
      'diff --git a/README.md b/README.md\n' +
      'index 07968ad..3b4ea49 100644\n' +
      '--- a/README.md\n' +
      '+++ b/README.md\n' +
      '@@ -1 +1,3 @@\n' +
      ' # Demo\n' +
      '+\n' +
      '+Staged on a review branch.';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
    const workspaceReview = {
      changeSet: {
        id: 'wcs_review_branch_1',
        materializationRecordId: 'wmr_review_branch_1',
        inputSnapshotId: 'wis_review_branch_1',
        workspaceId: workspace.id,
        resourceId: 'repo_default',
        strategy: 'git',
        base: { commit: baseCommit, contentDigest: null },
        head: { commit: 'worker-head', contentDigest: null },
        changedPaths: [{ path: 'README.md', status: 'modified', binary: false }],
        patch: {
          ref: 'worker-session://workspace.patch',
          digest: patchDigest,
          bytes: Buffer.byteLength(patchText, 'utf8'),
        },
        bundle: null,
        artifactIds: ['ar_workspace_review_branch_1'],
        evidenceRefs: [{ kind: 'worker', ref: turn.id }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: timestamp,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest: patchDigest,
        bytes: Buffer.byteLength(patchText, 'utf8'),
      },
      review: {
        id: 'swr_review_branch_1',
        changeSetId: 'wcs_review_branch_1',
        workspaceId: workspace.id,
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: 'staging://workspace/wcs_review_branch_1',
          branch: 'openkit/review/swr_review_branch_1',
        },
        diffSummary: { filesChanged: 1, additions: 2, deletions: 0 },
        riskSummary: '1 changed path staged for human review.',
        validation: [],
        actionCenterRowId: 'workspace-review:swr_review_branch_1',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    store.createArtifact({
      id: 'ar_workspace_review_branch_1',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: workspaceReview.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(workspaceReview) },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReview);
    } finally {
      workspaceDb.sqlite.close();
    }

    const initialBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    const reviewsRes = await app.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/reviews`
    );

    expect(reviewsRes.status).toBe(200);
    expect(
      execFileSync('git', ['branch', '--show-current'], { cwd: repoDir, encoding: 'utf8' }).trim()
    ).toBe(initialBranch);
    expect(() =>
      execFileSync(
        'git',
        ['rev-parse', '--verify', 'refs/heads/openkit/review/swr_review_branch_1'],
        { cwd: repoDir, stdio: 'ignore' }
      )
    ).toThrow();

    const acceptRes = await app.request(
      `/api/app/workspaces/${workspace.id}/artifacts/ar_workspace_review_branch_1/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-review-branch-request-1',
          decision: 'accepted',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(acceptRes.status, await acceptRes.clone().text()).toBe(200);
    expect(() =>
      execFileSync(
        'git',
        ['rev-parse', '--verify', 'refs/heads/openkit/review/swr_review_branch_1'],
        {
          cwd: repoDir,
          stdio: 'ignore',
        }
      )
    ).toThrow();
  });

  it('rejects a workspace review when the repository head drifted from its base', async () => {
    const fixture = await createGitWorkspaceReviewFixture({ reviewId: 'swr_base_drift' });

    try {
      writeFileSync(join(fixture.repoDir, 'drift.txt'), 'Repository advanced.\n', 'utf8');
      execFileSync('git', ['add', 'drift.txt'], { cwd: fixture.repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'advance repository'], {
        cwd: fixture.repoDir,
        stdio: 'ignore',
      });
      const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture.repoDir,
        encoding: 'utf8',
      }).trim();
      const statusBefore = execFileSync('git', ['status', '--short'], {
        cwd: fixture.repoDir,
        encoding: 'utf8',
      });

      const response = await fixture.app.request(
        `/api/app/workspaces/${fixture.workspaceId}/artifacts/${fixture.artifactId}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ requestId: 'base-drift-1', decision: 'accepted' }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(response.status).not.toBe(200);
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: fixture.repoDir,
          encoding: 'utf8',
        }).trim()
      ).toBe(headBefore);
      expect(
        execFileSync('git', ['status', '--short'], {
          cwd: fixture.repoDir,
          encoding: 'utf8',
        })
      ).toBe(statusBefore);
      expect(readFileSync(join(fixture.repoDir, 'README.md'), 'utf8')).toBe('# Demo\n');
      const workspaceDb = openTestWorkspaceDb(fixture.coreDb, fixture.workspaceId);
      try {
        expect(
          getWorkspaceSyncReview(workspaceDb, fixture.workspaceId, fixture.review.review.id)?.review
            .status
        ).toBe('pending');
        expect(listWorkspaceApplyPlans(workspaceDb, fixture.workspaceId)).toHaveLength(1);
        expect(listWorkspaceApplyResults(workspaceDb, fixture.workspaceId)).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('rejects a workspace patch whose paths differ from its declared manifest', async () => {
    const patchText =
      'diff --git a/README.md b/README.md\n' +
      '--- a/README.md\n' +
      '+++ b/README.md\n' +
      '@@ -1 +1,3 @@\n' +
      ' # Demo\n' +
      '+\n' +
      '+Declared change.\n' +
      'diff --git a/extra.txt b/extra.txt\n' +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      '+++ b/extra.txt\n' +
      '@@ -0,0 +1 @@\n' +
      '+Undeclared change.';
    const fixture = await createGitWorkspaceReviewFixture({
      patchText,
      reviewId: 'swr_path_mismatch',
    });

    try {
      const response = await fixture.app.request(
        `/api/app/workspaces/${fixture.workspaceId}/artifacts/${fixture.artifactId}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ requestId: 'path-mismatch-1', decision: 'accepted' }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(response.status).not.toBe(200);
      expect(readFileSync(join(fixture.repoDir, 'README.md'), 'utf8')).toBe('# Demo\n');
      expect(() => readFileSync(join(fixture.repoDir, 'extra.txt'), 'utf8')).toThrow();
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: fixture.repoDir,
          encoding: 'utf8',
        }).trim()
      ).toBe(fixture.baseCommit);
      expect(
        execFileSync('git', ['status', '--short'], {
          cwd: fixture.repoDir,
          encoding: 'utf8',
        })
      ).toBe('');
      const workspaceDb = openTestWorkspaceDb(fixture.coreDb, fixture.workspaceId);
      try {
        expect(
          getWorkspaceSyncReview(workspaceDb, fixture.workspaceId, fixture.review.review.id)?.review
            .status
        ).toBe('pending');
        expect(listWorkspaceApplyPlans(workspaceDb, fixture.workspaceId)).toHaveLength(1);
        expect(listWorkspaceApplyResults(workspaceDb, fixture.workspaceId)).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('restores Git state when accepted review persistence fails', async () => {
    const fixture = await createGitWorkspaceReviewFixture({ reviewId: 'swr_persist_rollback' });
    writeFileSync(join(fixture.repoDir, 'unrelated.txt'), 'Keep staged.\n', 'utf8');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: fixture.repoDir, stdio: 'ignore' });
    const statusBefore = execFileSync('git', ['status', '--short'], {
      cwd: fixture.repoDir,
      encoding: 'utf8',
    });
    const workspaceDb = openTestWorkspaceDb(fixture.coreDb, fixture.workspaceId);
    try {
      recordWorkspaceSyncReview(workspaceDb, { item: fixture.review });
      workspaceDb.sqlite.exec(`CREATE TRIGGER fail_workspace_apply_result
        BEFORE INSERT ON workspace_apply_results
        BEGIN
          SELECT RAISE(FAIL, 'apply result persistence failed');
        END;`);
    } finally {
      workspaceDb.sqlite.close();
    }

    try {
      const response = await fixture.app.request(
        `/api/app/workspaces/${fixture.workspaceId}/artifacts/${fixture.artifactId}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ requestId: 'persist-rollback-1', decision: 'accepted' }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(response.status).not.toBe(200);
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: fixture.repoDir,
          encoding: 'utf8',
        }).trim()
      ).toBe(fixture.baseCommit);
      expect(readFileSync(join(fixture.repoDir, 'README.md'), 'utf8')).toBe('# Demo\n');
      expect(
        execFileSync('git', ['status', '--short'], {
          cwd: fixture.repoDir,
          encoding: 'utf8',
        })
      ).toBe(statusBefore);
      expect(
        execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: fixture.repoDir,
          encoding: 'utf8',
        }).trim()
      ).toBe('unrelated.txt');
      const persistedDb = openTestWorkspaceDb(fixture.coreDb, fixture.workspaceId);
      try {
        expect(
          getWorkspaceSyncReview(persistedDb, fixture.workspaceId, fixture.review.review.id)?.review
            .status
        ).toBe('pending');
        expect(listWorkspaceApplyPlans(persistedDb, fixture.workspaceId)).toHaveLength(1);
        expect(listWorkspaceApplyResults(persistedDb, fixture.workspaceId)).toEqual([]);
      } finally {
        persistedDb.sqlite.close();
      }
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('rolls back accepted workspace synchronization review patches when commit identity is missing', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const workspace = store.createWorkspace('Workspace sync rollback');
    const thread = store.createThread(workspace.id, 'Rollback workspace review');
    const turn = store.createTurn(workspace.id, thread.id, 'Produce workspace patch');
    const repoDir = mkdtempSync(join(tmpdir(), 'openkit-workspace-rollback-'));
    const timestamp = new Date().toISOString();

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'repository-local@example.invalid'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Repository Local'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    await app.request(`/api/app/workspaces/${workspace.id}/repositories/default`, {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Rollback fixture',
        git: { authorEmail: null, authorName: null, commitOnApply: true },
        localPath: repoDir,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const patchText =
      'diff --git a/README.md b/README.md\n' +
      'index 07968ad..6ed4c95 100644\n' +
      '--- a/README.md\n' +
      '+++ b/README.md\n' +
      '@@ -1 +1,3 @@\n' +
      ' # Demo\n' +
      '+\n' +
      '+Should roll back.';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
    const workspaceReview = {
      changeSet: {
        id: 'wcs_rollback_1',
        materializationRecordId: 'wmr_rollback_1',
        inputSnapshotId: 'wis_rollback_1',
        workspaceId: workspace.id,
        resourceId: 'repo_default',
        strategy: 'git',
        base: { commit: baseCommit, contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: 'README.md', status: 'modified', binary: false }],
        patch: {
          ref: 'worker-session://workspace.patch',
          digest: patchDigest,
          bytes: Buffer.byteLength(patchText, 'utf8'),
        },
        bundle: null,
        artifactIds: ['ar_workspace_rollback_1'],
        evidenceRefs: [{ kind: 'worker', ref: turn.id }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: timestamp,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest: patchDigest,
        bytes: Buffer.byteLength(patchText, 'utf8'),
      },
      review: {
        id: 'swr_rollback_1',
        changeSetId: 'wcs_rollback_1',
        workspaceId: workspace.id,
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: 'staging://workspace/wcs_rollback_1',
          branch: null,
        },
        diffSummary: { filesChanged: 1, additions: 2, deletions: 0 },
        riskSummary: '1 changed path staged for human review.',
        validation: [],
        actionCenterRowId: 'workspace-review:swr_rollback_1',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    store.createArtifact({
      id: 'ar_workspace_rollback_1',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'diff',
      title: 'Workspace changes ready for review',
      status: 'ready',
      summary: workspaceReview.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(workspaceReview) },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReview);
    } finally {
      workspaceDb.sqlite.close();
    }

    const acceptRes = await app.request(
      `/api/app/workspaces/${workspace.id}/artifacts/ar_workspace_rollback_1/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'workspace-rollback-request-1',
          decision: 'accepted',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(acceptRes.status).toBe(500);
    await expect(acceptRes.json()).resolves.toMatchObject({
      message: 'Workspace repository has no Git identity: swr_rollback_1',
    });
    expect(readFileSync(join(repoDir, 'README.md'), 'utf8')).toBe('# Demo\n');
    expect(execFileSync('git', ['status', '--short'], { cwd: repoDir, encoding: 'utf8' })).toBe('');
    expect(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim()
    ).toBe('1');
  });

  it('applies accepted filesystem workspace synchronization reviews through opaque staging', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Filesystem workspace sync apply');
    const thread = store.createThread(workspace.id, 'Apply filesystem workspace review');
    const turn = store.createTurn(workspace.id, thread.id, 'Produce filesystem changes');
    const targetRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-apply-target-'));
    const workerRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-apply-worker-'));
    const stagingRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-apply-staging-'));
    const timestamp = new Date().toISOString();

    mkdirSync(join(targetRoot, 'docs'), { recursive: true });
    mkdirSync(join(workerRoot, 'docs'), { recursive: true });
    writeFileSync(join(targetRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    writeFileSync(join(targetRoot, 'old.txt'), 'remove me\n', 'utf8');
    writeFileSync(join(targetRoot, 'script.sh'), '#!/bin/sh\necho demo\n', 'utf8');
    writeFileSync(join(workerRoot, 'docs', 'guide.md'), '# Guide\n\nApplied.\n', 'utf8');
    writeFileSync(join(workerRoot, 'new.txt'), 'new file\n', 'utf8');
    writeFileSync(join(workerRoot, 'script.sh'), '#!/bin/sh\necho demo\n', 'utf8');
    chmodSync(join(targetRoot, 'script.sh'), 0o644);
    chmodSync(join(workerRoot, 'script.sh'), 0o755);

    const before = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: targetRoot,
      workspaceId: workspace.id,
    });
    const after = await createFilesystemSnapshotManifest({
      createdAt: timestamp,
      resourceId: 'fs_default',
      rootPath: workerRoot,
      workspaceId: workspace.id,
    });
    const changeSet = buildFilesystemWorkspaceChangeSet({
      after,
      before,
      changeSetId: 'wcs_filesystem_apply_1',
      createdAt: timestamp,
      inputSnapshotId: 'wis_filesystem_apply_1',
      materializationRecordId: 'wmr_filesystem_apply_1',
    });

    await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });

    const workspaceReview = {
      changeSet,
      patchPayload: null,
      review: {
        id: 'swr_filesystem_apply_1',
        changeSetId: changeSet.id,
        workspaceId: workspace.id,
        status: 'pending',
        staging: {
          strategy: 'filesystem_staging',
          ref: 'filesystem-staging://swr_filesystem_apply_1',
          branch: null,
        },
        diffSummary: { filesChanged: 4, additions: 0, deletions: 0 },
        riskSummary: '4 changed paths staged for human review.',
        validation: [],
        actionCenterRowId: 'workspace-review:swr_filesystem_apply_1',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };

    const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
    try {
      recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReview);
      recordFilesystemWorkspaceStagingRoot(workspaceDb, {
        before,
        changeSetId: changeSet.id,
        createdAt: timestamp,
        reviewId: workspaceReview.review.id,
        stagingRootPath: stagingRoot,
        targetRootPath: targetRoot,
        workspaceId: workspace.id,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    store.createArtifact({
      id: 'ar_filesystem_workspace_apply_1',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'diff',
      title: 'Filesystem workspace changes ready for review',
      status: 'ready',
      summary: workspaceReview.review.riskSummary,
      version: 1,
      content: { format: 'json', body: JSON.stringify(workspaceReview) },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const restartedApp = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const acceptRes = await restartedApp.request(
      `/api/app/workspaces/${workspace.id}/artifacts/ar_filesystem_workspace_apply_1/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'filesystem-workspace-apply-request-1',
          decision: 'accepted',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(acceptRes.status, await acceptRes.clone().text()).toBe(200);
    await expect(acceptRes.json()).resolves.toMatchObject({
      workspaceApplyResult: {
        status: 'applied',
        appliedPaths: ['docs/guide.md', 'new.txt', 'old.txt', 'script.sh'],
        reviewId: 'swr_filesystem_apply_1',
      },
    });
    expect(readFileSync(join(targetRoot, 'docs', 'guide.md'), 'utf8')).toBe(
      '# Guide\n\nApplied.\n'
    );
    expect(readFileSync(join(targetRoot, 'new.txt'), 'utf8')).toBe('new file\n');
    expect(() => readFileSync(join(targetRoot, 'old.txt'), 'utf8')).toThrow();
    expect((statSync(join(targetRoot, 'script.sh')).mode & 0o777).toString(8)).toBe('755');

    const readApplyResult = await restartedApp.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/apply-results/war_swr_filesystem_apply_1`
    );
    const listApplyPlans = await restartedApp.request(
      `/api/app/workspaces/${workspace.id}/workspace-sync/apply-plans`
    );

    expect(readApplyResult.status).toBe(200);
    await expect(readApplyResult.json()).resolves.toMatchObject({
      id: 'war_swr_filesystem_apply_1',
      status: 'applied',
    });
    expect(listApplyPlans.status).toBe(200);
    await expect(listApplyPlans.json()).resolves.toMatchObject({
      items: [
        {
          id: 'wap_swr_filesystem_apply_1',
          reviewId: 'swr_filesystem_apply_1',
          strategy: 'filesystem',
          permissionChanges: ['script.sh'],
          plannedWrites: ['docs/guide.md', 'new.txt', 'old.txt', 'script.sh'],
        },
      ],
    });
  });

  it('restores filesystem state when accepted review persistence fails', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Filesystem apply persistence rollback');
    const thread = store.createThread(workspace.id, 'Rollback filesystem workspace review');
    const turn = store.createTurn(workspace.id, thread.id, 'Produce filesystem changes');
    const targetRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-rollback-target-'));
    const workerRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-rollback-worker-'));
    const stagingRoot = mkdtempSync(join(tmpdir(), 'openkit-filesystem-rollback-staging-'));
    const timestamp = new Date().toISOString();

    try {
      mkdirSync(join(targetRoot, 'docs'), { recursive: true });
      mkdirSync(join(workerRoot, 'docs'), { recursive: true });
      writeFileSync(join(targetRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
      writeFileSync(join(targetRoot, 'old.txt'), 'restore deleted file\n', 'utf8');
      writeFileSync(join(targetRoot, 'script.sh'), '#!/bin/sh\necho demo\n', 'utf8');
      writeFileSync(join(workerRoot, 'docs', 'guide.md'), '# Guide\n\nApplied.\n', 'utf8');
      writeFileSync(join(workerRoot, 'new.txt'), 'remove added file\n', 'utf8');
      writeFileSync(join(workerRoot, 'script.sh'), '#!/bin/sh\necho demo\n', 'utf8');
      chmodSync(join(targetRoot, 'script.sh'), 0o644);
      chmodSync(join(workerRoot, 'script.sh'), 0o755);

      const before = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_default',
        rootPath: targetRoot,
        workspaceId: workspace.id,
      });
      const after = await createFilesystemSnapshotManifest({
        createdAt: timestamp,
        resourceId: 'fs_default',
        rootPath: workerRoot,
        workspaceId: workspace.id,
      });
      const changeSet = buildFilesystemWorkspaceChangeSet({
        after,
        before,
        changeSetId: 'wcs_filesystem_persist_rollback',
        createdAt: timestamp,
        inputSnapshotId: 'wis_filesystem_persist_rollback',
        materializationRecordId: 'wmr_filesystem_persist_rollback',
      });
      await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });

      const workspaceReview = {
        artifactId: 'ar_filesystem_persist_rollback',
        changeSet,
        patchPayload: null,
        review: {
          id: 'swr_filesystem_persist_rollback',
          changeSetId: changeSet.id,
          workspaceId: workspace.id,
          status: 'pending',
          staging: {
            strategy: 'filesystem_staging',
            ref: 'filesystem-staging://swr_filesystem_persist_rollback',
            branch: null,
          },
          diffSummary: { filesChanged: 4, additions: 0, deletions: 0 },
          riskSummary: '4 changed paths staged for human review.',
          validation: [],
          actionCenterRowId: 'workspace-review:swr_filesystem_persist_rollback',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      };
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordTestWorkspaceReviewMaterialization(workspaceDb, workspaceReview);
        recordWorkspaceSyncReview(workspaceDb, { item: workspaceReview });
        recordFilesystemWorkspaceStagingRoot(workspaceDb, {
          before,
          changeSetId: changeSet.id,
          createdAt: timestamp,
          reviewId: workspaceReview.review.id,
          stagingRootPath: stagingRoot,
          targetRootPath: targetRoot,
          workspaceId: workspace.id,
        });
        workspaceDb.sqlite.exec(`CREATE TRIGGER fail_filesystem_workspace_apply_result
          BEFORE INSERT ON workspace_apply_results
          BEGIN
            SELECT RAISE(FAIL, 'filesystem apply result persistence failed');
          END;`);
      } finally {
        workspaceDb.sqlite.close();
      }
      store.createArtifact({
        id: 'ar_filesystem_persist_rollback',
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        kind: 'diff',
        title: 'Filesystem workspace changes ready for review',
        status: 'ready',
        summary: workspaceReview.review.riskSummary,
        version: 1,
        content: { format: 'json', body: JSON.stringify(workspaceReview) },
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
      const response = await app.request(
        `/api/app/workspaces/${workspace.id}/artifacts/ar_filesystem_persist_rollback/review`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'filesystem-persist-rollback-request-1',
            decision: 'accepted',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(response.status).not.toBe(200);
      expect(readFileSync(join(targetRoot, 'docs', 'guide.md'), 'utf8')).toBe('# Guide\n');
      expect(() => readFileSync(join(targetRoot, 'new.txt'), 'utf8')).toThrow();
      expect(readFileSync(join(targetRoot, 'old.txt'), 'utf8')).toBe('restore deleted file\n');
      expect(readFileSync(join(targetRoot, 'script.sh'), 'utf8')).toBe('#!/bin/sh\necho demo\n');
      expect(statSync(join(targetRoot, 'script.sh')).mode & 0o777).toBe(0o644);

      const persistedDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        expect(
          getWorkspaceSyncReview(persistedDb, workspace.id, workspaceReview.review.id)?.review
            .status
        ).toBe('pending');
        expect(listWorkspaceApplyPlans(persistedDb, workspace.id)).toHaveLength(1);
        expect(listWorkspaceApplyResults(persistedDb, workspace.id)).toEqual([]);
      } finally {
        persistedDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
      rmSync(targetRoot, { force: true, recursive: true });
      rmSync(workerRoot, { force: true, recursive: true });
      rmSync(stagingRoot, { force: true, recursive: true });
    }
  });

  it('accepts a goal review, unlocks its dependent task, and replays persisted state', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Goal review decision');
    const turn = store.createTurn('ws_demo', thread.id, 'Review the first Goal Task');
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_route',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Route goal review',
        objective: 'Resolve a Goal Review attention row.',
        status: 'reviewing',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      createGoalTask(workspaceDb, {
        ...GOAL_TASK_RECORD_FIXTURE,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_route',
        planItemId: 'it_goal_plan_route',
        taskId: 'task_route_1',
        title: 'First reviewed task',
        objective: 'Complete the first reviewed task.',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['The first task is accepted.'],
        contextBudgetTokens: 1024,
        status: 'reviewing',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      createGoalTask(workspaceDb, {
        ...GOAL_TASK_RECORD_FIXTURE,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_route',
        planItemId: 'it_goal_plan_route',
        taskId: 'task_route_2',
        title: 'Dependent task',
        objective: 'Continue after the first task is accepted.',
        orderIndex: 2,
        dependsOnTaskIds: ['task_route_1'],
        acceptanceCriteria: ['The dependent task becomes ready.'],
        contextBudgetTokens: 1024,
        status: 'pending',
        now: () => '2026-05-31T00:00:30.000Z',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_route',
        status: 'reviewing',
        planItemId: 'it_goal_plan_route',
        currentTaskId: 'task_route_1',
        now: () => '2026-05-31T00:00:30.000Z',
      });
      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_route',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_route',
        taskId: 'task_route_1',
        turnId: turn.id,
        prompt: 'Review the first Task evidence.',
        createdByRequestId: 'goal-step-route-1',
        now: () => '2026-05-31T00:01:00.000Z',
      });

      const href = `/api/app/workspaces/ws_demo/threads/${thread.id}/goals/goal_route/reviews/review_route/decision`;
      const firstRes = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({ requestId: 'goal-review-request-1', verdict: 'accept' }),
        headers: { 'content-type': 'application/json' },
      });
      const secondRes = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({ requestId: 'goal-review-request-1', verdict: 'accept' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);
      const first = await firstRes.json();
      const second = await secondRes.json();
      expect(second).toEqual(first);
      workspaceDb.sqlite
        .prepare(
          `DELETE FROM idempotency_requests
          WHERE command_name = 'goal.review.decide'
            AND request_id = 'goal-review-request-1'`
        )
        .run();
      const snapshotFallbackRes = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({ requestId: 'goal-review-request-1', verdict: 'accept' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(snapshotFallbackRes.status).toBe(200);
      expect(await snapshotFallbackRes.json()).toEqual(first);
      expect(first).toMatchObject({
        advance: {
          outcome: 'complete_next_task',
          task: { taskId: 'task_route_1', status: 'completed' },
          goal: { status: 'running', currentTaskId: null },
          nextReadyTaskId: 'task_route_2',
        },
      });
      expect(
        getGoalReviewRecord(workspaceDb, 'ws_demo', thread.id, 'goal_route', 'review_route')
      ).toMatchObject({
        resolvedAt: expect.any(String),
        verdict: 'accept',
        resolutionRequestId: 'goal-review-request-1',
        resolvedByActorId: 'user_local',
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_route',
        }).map((task) => ({ taskId: task.taskId, status: task.status }))
      ).toEqual([
        { taskId: 'task_route_1', status: 'completed' },
        { taskId: 'task_route_2', status: 'ready' },
      ]);
      expect(
        listGoalRecordsForThread(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        }).find((goal) => goal.goalId === 'goal_route')
      ).toMatchObject({ status: 'running', currentTaskId: null });

      updateGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_route',
        taskId: 'task_route_2',
        status: 'completed',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_route',
        status: 'completed',
        currentTaskId: null,
        terminalStopReason: 'completed',
      });
      const delayedReplayRes = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({ requestId: 'goal-review-request-1', verdict: 'accept' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(delayedReplayRes.status).toBe(200);
      expect(await delayedReplayRes.json()).toEqual(first);
      const conflictingReplay = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'goal-review-request-1',
          verdict: 'abort',
          reason: 'Abort instead.',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const staleDecision = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({ requestId: 'goal-review-request-2', verdict: 'accept' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(conflictingReplay.status).toBe(409);
      expect(await conflictingReplay.json()).toMatchObject({ code: 'idempotency_key_conflict' });
      expect(staleDecision.status).toBe(409);
      expect(await staleDecision.json()).toMatchObject({ code: 'stale' });

      workspaceDb.sqlite
        .prepare(
          `UPDATE goal_review_records
          SET resolved_by_actor_id = NULL
          WHERE workspace_id = 'ws_demo' AND review_id = 'review_route'`
        )
        .run();
      const recoveryRequired = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({ requestId: 'goal-review-request-3', verdict: 'accept' }),
        headers: { 'content-type': 'application/json' },
      });

      expect(recoveryRequired.status).toBe(409);
      expect(await recoveryRequired.json()).toMatchObject({ code: 'recovery_required' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('completes a goal when its final goal review is accepted', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Final goal review decision');
    const turn = store.createTurn('ws_demo', thread.id, 'Review the final Goal Task');
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_final_review',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Final route goal review',
        objective: 'Complete a goal after its final task is accepted.',
        status: 'reviewing',
        now: () => '2026-05-31T01:00:00.000Z',
      });
      createGoalTask(workspaceDb, {
        ...GOAL_TASK_RECORD_FIXTURE,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_final_review',
        planItemId: 'it_goal_plan_final_review',
        taskId: 'task_final_review',
        title: 'Final reviewed task',
        objective: 'Complete the goal.',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['The goal is completed.'],
        contextBudgetTokens: 1024,
        status: 'reviewing',
        now: () => '2026-05-31T01:00:30.000Z',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_final_review',
        status: 'reviewing',
        planItemId: 'it_goal_plan_final_review',
        currentTaskId: 'task_final_review',
        now: () => '2026-05-31T01:00:30.000Z',
      });
      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_final_route',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_final_review',
        taskId: 'task_final_review',
        turnId: turn.id,
        prompt: 'Review the final Task evidence.',
        createdByRequestId: 'goal-step-final-1',
        now: () => '2026-05-31T01:01:00.000Z',
      });

      const response = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goals/goal_final_review/reviews/review_final_route/decision`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: 'goal-review-final-request-1',
            verdict: 'accept',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        advance: {
          outcome: 'complete_goal',
          task: { taskId: 'task_final_review', status: 'completed' },
          goal: { status: 'completed', currentTaskId: null, terminalStopReason: 'completed' },
          nextReadyTaskId: null,
        },
      });
      expect(
        getGoalReviewRecord(
          workspaceDb,
          'ws_demo',
          thread.id,
          'goal_final_review',
          'review_final_route'
        )
      ).toMatchObject({
        resolvedAt: expect.any(String),
        resolutionRequestId: 'goal-review-final-request-1',
      });
      expect(
        listGoalTasks(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_final_review',
        })
      ).toEqual([expect.objectContaining({ taskId: 'task_final_review', status: 'completed' })]);
      expect(
        listGoalRecordsForThread(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
        }).find((goal) => goal.goalId === 'goal_final_review')
      ).toMatchObject({
        status: 'completed',
        currentTaskId: null,
        terminalStopReason: 'completed',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rolls back a goal review decision when review resolution persistence fails', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Goal review rollback');
    const turn = store.createTurn('ws_demo', thread.id, 'Review the rollback Goal Task');
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });

    try {
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_review_rollback',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Rollback route goal review',
        objective: 'Roll back all state when review resolution fails.',
        status: 'reviewing',
        now: () => '2026-05-31T02:00:00.000Z',
      });
      createGoalTask(workspaceDb, {
        ...GOAL_TASK_RECORD_FIXTURE,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_review_rollback',
        planItemId: 'it_goal_plan_review_rollback',
        taskId: 'task_review_rollback_1',
        title: 'Reviewed rollback task',
        objective: 'Remain reviewing after a failed decision.',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['The decision is atomic.'],
        contextBudgetTokens: 1024,
        status: 'reviewing',
        now: () => '2026-05-31T02:00:30.000Z',
      });
      createGoalTask(workspaceDb, {
        ...GOAL_TASK_RECORD_FIXTURE,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_review_rollback',
        planItemId: 'it_goal_plan_review_rollback',
        taskId: 'task_review_rollback_2',
        title: 'Dependent rollback task',
        objective: 'Remain pending after a failed decision.',
        orderIndex: 2,
        dependsOnTaskIds: ['task_review_rollback_1'],
        acceptanceCriteria: ['The task unlocks only after a durable decision.'],
        contextBudgetTokens: 1024,
        status: 'pending',
        now: () => '2026-05-31T02:01:00.000Z',
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_review_rollback',
        status: 'reviewing',
        planItemId: 'it_goal_plan_review_rollback',
        currentTaskId: 'task_review_rollback_1',
        now: () => '2026-05-31T02:01:00.000Z',
      });
      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_rollback',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_review_rollback',
        taskId: 'task_review_rollback_1',
        turnId: turn.id,
        prompt: 'Review the first Task atomically.',
        createdByRequestId: 'goal-step-rollback-1',
        now: () => '2026-05-31T02:01:30.000Z',
      });
      workspaceDb.sqlite.exec(`CREATE TRIGGER fail_goal_review_resolution
        BEFORE UPDATE OF resolved_at ON goal_review_records
        WHEN NEW.review_id = 'review_rollback'
        BEGIN
          SELECT RAISE(ABORT, 'forced goal review resolution failure');
        END;`);

      const href = `/api/app/workspaces/ws_demo/threads/${thread.id}/goals/goal_review_rollback/reviews/review_rollback/decision`;
      const failedResponse = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'goal-review-rollback-request-1',
          verdict: 'accept',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const reviewAfterFailure = getGoalReviewRecord(
        workspaceDb,
        'ws_demo',
        thread.id,
        'goal_review_rollback',
        'review_rollback'
      );
      const tasksAfterFailure = listGoalTasks(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_review_rollback',
      }).map((task) => ({ taskId: task.taskId, status: task.status }));
      const goalAfterFailure = listGoalRecordsForThread(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
      }).find((goal) => goal.goalId === 'goal_review_rollback');

      workspaceDb.sqlite.exec('DROP TRIGGER fail_goal_review_resolution');
      const retryResponse = await app.request(href, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'goal-review-rollback-request-1',
          verdict: 'accept',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(failedResponse.status).not.toBe(200);
      expect(reviewAfterFailure).toMatchObject({
        verdict: null,
        resolvedAt: null,
        resolutionRequestId: null,
        resolvedByActorId: null,
        resolutionSnapshot: null,
      });
      expect(tasksAfterFailure).toEqual([
        { taskId: 'task_review_rollback_1', status: 'reviewing' },
        { taskId: 'task_review_rollback_2', status: 'pending' },
      ]);
      expect(goalAfterFailure).toMatchObject({ status: 'reviewing' });
      expect(retryResponse.status).toBe(200);
      expect(await retryResponse.json()).toMatchObject({
        advance: {
          outcome: 'complete_next_task',
          task: { taskId: 'task_review_rollback_1', status: 'completed' },
          goal: { status: 'running', currentTaskId: null },
          nextReadyTaskId: 'task_review_rollback_2',
        },
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('routes interrupts through the turn executor', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Interrupt this running turn');
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() });
    const interruptRes = await app.request(
      `/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}/interrupt`,
      {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          requestId: '0190f4c8-0000-7000-8000-000000000206',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(interruptRes.status).toBe(200);
    expect((await interruptRes.json()) as { status: string }).toMatchObject({
      status: 'interrupted',
    });
    expect(store.getTurnEvents(turn.id).at(-1)?.requestId).toBe(
      '0190f4c8-0000-7000-8000-000000000206'
    );
  });

  it('projects live OpenShell worker control status into thread dashboard sessions', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Show worker control status');
    const environmentPackage = createOpenShellWorkerControlPackage(store, turn.id);
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_dashboard_control_1',
      now: () => '2026-06-16T00:00:03.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);
    const lineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };

    gateway.recordHeartbeat({
      authorization: `Bearer ${registration.token}`,
      body: {
        message: null,
        status: 'running',
      },
      lineage,
      operation: 'heartbeat',
      schemaVersion: 1,
      sequence: 4,
    });
    gateway.recordArtifactNotice({
      artifact: {
        mediaType: 'text/markdown',
        path: '/openkit/artifacts/report.md',
        title: 'Worker report',
      },
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 5,
    });
    gateway.enqueueInterrupt(environmentPackage.snapshotId, 'Stop now');
    gateway.enqueueTerminalCommand(environmentPackage.snapshotId, {
      argv: ['pwd'],
      commandId: 'term_dashboard_1',
      cwd: '/workspace',
    });
    gateway.pollCommands({
      authorization: `Bearer ${registration.token}`,
      lineage,
    });
    gateway.recordTerminalResult({
      authorization: `Bearer ${registration.token}`,
      durationMs: 12,
      exitCode: 0,
      lineage,
      stderr: '',
      stdout: '/workspace\n',
      terminalCommandId: 'term_dashboard_1',
    });

    const app = createApp({
      store,
      turnExecutor: new OpenShellDashboardTurnExecutor({
        id: environmentPackage.scope.agentSessionId,
        status: 'busy',
        message: null,
        configVersion: 1,
        workspaceRoots: [],
        stale: false,
        sandboxSummary: null,
        backend: {
          kind: 'openshell',
          health: 'ready',
          controlMode: 'direct-nanocore',
          control: null,
          gatewayName: 'openshell',
          gatewayEndpoint: 'https://127.0.0.1:17670',
          version: '0.0.63',
          sandboxName: 'openkit-as-dashboard-control-1',
        },
      }),
      workerControlGateway: gateway,
    });
    const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/dashboard');
    const body = (await res.json()) as {
      activeSession: { backend: { control: Record<string, unknown> | null } };
    };

    expect(res.status).toBe(200);
    expect(body.activeSession.backend.control).toMatchObject({
      heartbeat: {
        status: 'running',
        sequence: 4,
        lastHeartbeatAt: '2026-06-16T00:00:03.000Z',
      },
      artifactNoticeCount: 1,
      queuedCommandCount: 1,
      deliveredCommandCount: 1,
      terminalResultCount: 1,
      lastTerminalExitCode: 0,
      lastTerminalCompletedAt: '2026-06-16T00:00:03.000Z',
    });
  });

  it('projects worker control status from the active package snapshot when a session id is reused', async () => {
    const store = createDemoStore();
    const oldTurn = store.createTurn('ws_demo', 'th_demo', 'Run the old worker package');
    const currentTurn = store.createTurn('ws_demo', 'th_demo', 'Run the current worker package');
    const oldPackage = createOpenShellWorkerControlPackage(store, oldTurn.id);
    const currentPackage = createOpenShellWorkerControlPackage(store, currentTurn.id);
    const gateway = new WorkerControlGateway({
      createToken: vi
        .fn()
        .mockReturnValueOnce('token_dashboard_control_old')
        .mockReturnValueOnce('token_dashboard_control_current'),
      now: () => '2026-06-16T00:00:03.000Z',
    });
    const oldRegistration = gateway.registerSession(oldPackage);
    const currentRegistration = gateway.registerSession(currentPackage);
    const oldLineage = {
      agentSessionId: oldPackage.scope.agentSessionId,
      packageSnapshotId: oldPackage.snapshotId,
      requestId: oldPackage.scope.requestId,
      threadId: oldPackage.scope.threadId,
      turnId: oldPackage.scope.turnId,
      workspaceId: oldPackage.scope.workspaceId,
    };
    const currentLineage = {
      agentSessionId: currentPackage.scope.agentSessionId,
      packageSnapshotId: currentPackage.snapshotId,
      requestId: currentPackage.scope.requestId,
      threadId: currentPackage.scope.threadId,
      turnId: currentPackage.scope.turnId,
      workspaceId: currentPackage.scope.workspaceId,
    };

    gateway.recordHeartbeat({
      authorization: `Bearer ${oldRegistration.token}`,
      body: {
        message: null,
        status: 'stopping',
      },
      lineage: oldLineage,
      operation: 'heartbeat',
      schemaVersion: 1,
      sequence: 1,
    });
    gateway.recordArtifactNotice({
      artifact: {
        mediaType: 'text/markdown',
        path: '/openkit/artifacts/old-report.md',
        title: 'Old worker report',
      },
      authorization: `Bearer ${oldRegistration.token}`,
      lineage: oldLineage,
      sequence: 2,
    });
    gateway.recordHeartbeat({
      authorization: `Bearer ${currentRegistration.token}`,
      body: {
        message: null,
        status: 'running',
      },
      lineage: currentLineage,
      operation: 'heartbeat',
      schemaVersion: 1,
      sequence: 1,
    });
    store.createAgentSession({
      id: currentPackage.scope.agentSessionId,
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'busy',
      message: null,
      configVersion: 1,
      environmentPackageSnapshotId: currentPackage.snapshotId,
      workspaceRoots: [],
      createdAt: '2026-06-16T00:00:02.000Z',
      updatedAt: '2026-06-16T00:00:03.000Z',
    });
    const app = createApp({
      store,
      turnExecutor: new OpenShellDashboardTurnExecutor({
        id: currentPackage.scope.agentSessionId,
        status: 'busy',
        message: null,
        configVersion: 1,
        workspaceRoots: [],
        stale: false,
        sandboxSummary: null,
        backend: {
          kind: 'openshell',
          health: 'ready',
          controlMode: 'direct-nanocore',
          control: null,
          gatewayName: 'openshell',
          gatewayEndpoint: 'https://127.0.0.1:17670',
          version: '0.0.63',
          sandboxName: 'openkit-as-dashboard-control-current',
        },
      }),
      workerControlGateway: gateway,
    });

    const res = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/dashboard');
    const body = (await res.json()) as {
      activeSession: { backend: { control: Record<string, unknown> | null } };
    };

    expect(res.status).toBe(200);
    expect(body.activeSession.backend.control).toMatchObject({
      heartbeat: {
        status: 'running',
        sequence: 1,
      },
      artifactNoticeCount: 0,
    });

    const terminalRes = await app.request(
      `/api/app/workspaces/ws_demo/threads/th_demo/agent-sessions/${currentPackage.scope.agentSessionId}/terminal-commands`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'terminal-request-current-package',
          argv: ['pwd'],
          cwd: '/workspace',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(terminalRes.status).toBe(200);
    expect(gateway.getSessionSnapshot(oldPackage.snapshotId)?.commands).toEqual([]);
    expect(gateway.getSessionSnapshot(currentPackage.snapshotId)?.commands).toEqual([
      expect.objectContaining({ commandId: 'terminal-request-current-package' }),
    ]);

    const unavailableTurn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Run an unavailable worker package'
    );
    const unavailablePackage = createOpenShellWorkerControlPackage(store, unavailableTurn.id);
    store.updateAgentSession(currentPackage.scope.agentSessionId, {
      environmentPackageSnapshotId: unavailablePackage.snapshotId,
    });

    const unavailableRes = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/dashboard'
    );
    const unavailableBody = (await unavailableRes.json()) as {
      activeSession: { backend: { control: Record<string, unknown> | null } };
    };

    expect(unavailableRes.status).toBe(200);
    expect(unavailableBody.activeSession.backend.control).toBeNull();

    const unavailableTerminalRes = await app.request(
      `/api/app/workspaces/ws_demo/threads/th_demo/agent-sessions/${currentPackage.scope.agentSessionId}/terminal-commands`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'terminal-request-unavailable-package',
          argv: ['pwd'],
          cwd: '/workspace',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(unavailableTerminalRes.status).toBe(404);
    expect(gateway.getSessionSnapshot(oldPackage.snapshotId)?.commands).toEqual([]);
    expect(gateway.getSessionSnapshot(currentPackage.snapshotId)?.commands).toHaveLength(1);
  });

  it('queues terminal commands for the active OpenShell worker session', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Queue a terminal command');
    const environmentPackage = createOpenShellWorkerControlPackage(store, turn.id);
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_dashboard_control_1',
      now: () => '2026-06-16T00:00:03.000Z',
    });
    gateway.registerSession(environmentPackage);
    const app = createApp({
      store,
      turnExecutor: new OpenShellDashboardTurnExecutor({
        id: environmentPackage.scope.agentSessionId,
        status: 'busy',
        message: null,
        configVersion: 1,
        workspaceRoots: [],
        stale: false,
        sandboxSummary: null,
        backend: {
          kind: 'openshell',
          health: 'ready',
          controlMode: 'direct-nanocore',
          control: null,
          gatewayName: 'openshell',
          gatewayEndpoint: 'https://127.0.0.1:17670',
          version: '0.0.63',
          sandboxName: 'openkit-as-dashboard-control-1',
        },
      }),
      workerControlGateway: gateway,
    });

    const res = await app.request(
      `/api/app/workspaces/ws_demo/threads/th_demo/agent-sessions/${environmentPackage.scope.agentSessionId}/terminal-commands`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'terminal-request-1',
          argv: ['pwd'],
          cwd: '/workspace',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const body = (await res.json()) as {
      command: { argv: string[]; commandId: string; kind: string };
    };

    expect(res.status).toBe(200);
    expect(body.command).toMatchObject({
      argv: ['pwd'],
      commandId: 'terminal-request-1',
      kind: 'terminal-command',
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.commands).toEqual([
      expect.objectContaining({
        argv: ['pwd'],
        commandId: 'terminal-request-1',
        kind: 'terminal-command',
      }),
    ]);

    const wrongSessionRes = await app.request(
      '/api/app/workspaces/ws_demo/threads/th_demo/agent-sessions/as_wrong/terminal-commands',
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'terminal-request-wrong-session',
          argv: ['pwd'],
          cwd: '/workspace',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(wrongSessionRes.status).toBe(404);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.commands).toHaveLength(1);
  });

  it('passes the selected repository cwd to worker turn startup', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-turn-ready-repository-'));

    mkdirSync(join(repositoryPath, '.git'));

    try {
      const app = createApp({ coreDb, schedulerEpoch: 12, turnExecutor: executor });
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Ready repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const turnRes = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000211',
          input: 'Work in the repository',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(turnRes.status).toBe(202);
      expect(executor.startContexts).toHaveLength(1);
      expect(executor.startContexts[0]?.workspaceCwd).toBe(repositoryPath);
      expect(executor.startContexts[0]?.workspaceRoots).toEqual([
        expect.objectContaining({
          access: 'read-write',
          id: 'repo_default',
          sourceKind: 'host-dir',
          sourcePath: repositoryPath,
          workerPath: '/workspace/openkit',
        }),
      ]);
      expect(executor.startContexts[0]?.workspaceSourceRefs).toEqual({
        repo_default: 'repo_default',
      });
      expect(executor.startContexts[0]?.workspaceDataSourceCatalog).toMatchObject({
        sources: [
          expect.objectContaining({
            id: 'repo_default',
            kind: 'git',
            locator: { repositoryResourceId: 'repo_default' },
          }),
        ],
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT scheduler_epoch AS schedulerEpoch FROM scheduler_session_leases')
          .get()
      ).toEqual({ schedulerEpoch: 12 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lists and reads workspace Git push records through the App API', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb, turnExecutor: new FakeTurnExecutor() });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');

    try {
      recordGitPushRecord(workspaceDb, {
        requestId: '00000000-0000-4000-8000-000000000023',
        record: {
          actorId: 'user_1',
          approvalRowId: 'har_1',
          commitIds: ['abc123'],
          createdAt: '2026-07-05T00:00:00.000Z',
          errorSummary: null,
          id: 'gpr_route_1',
          outcome: 'pushed',
          policyDecisionId: 'pd_1',
          remoteHeadAfter: 'abc123',
          remoteHeadBefore: 'def456',
          remoteSummary: 'GitHub repository openkit on origin',
          repositoryResourceId: 'repo_default',
          reviewIds: ['swr_1'],
          sourceRef: 'HEAD',
          targetBranch: 'main',
          updatedAt: '2026-07-05T00:00:00.000Z',
          workspaceId: 'ws_demo',
        },
      });

      const listRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/git-push-records'
      );
      const readRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/git-push-records/gpr_route_1'
      );

      expect(listRes.status).toBe(200);
      await expect(listRes.json()).resolves.toMatchObject({
        items: [
          {
            id: 'gpr_route_1',
            commitIds: ['abc123'],
            outcome: 'pushed',
            repositoryResourceId: 'repo_default',
          },
        ],
      });
      expect(readRes.status).toBe(200);
      await expect(readRes.json()).resolves.toMatchObject({
        id: 'gpr_route_1',
        reviewIds: ['swr_1'],
        targetBranch: 'main',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('requests and resolves Git push approvals through the App API', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new FakeTurnExecutor() });
    const workspace = store.createWorkspace('Git push approval');
    const thread = store.createThread(workspace.id, 'Publish accepted work');
    const turn = store.createTurn(workspace.id, thread.id, 'Publish accepted work');
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-approval-repository-'));

    execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'repository-local@example.invalid'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Repository Local'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    writeFileSync(join(repositoryPath, 'README.md'), '# Approval\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'approvable change'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/openkit/openkit.git'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    const commitId = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      encoding: 'utf8',
    }).trim();

    try {
      const repositoryRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/default`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            displayName: 'Publish repository',
            localPath: repositoryPath,
            git: {
              authorEmail: null,
              authorName: null,
              allowedPushTargets: ['main'],
              commitOnApply: true,
            },
          }),
        }
      );

      expect(repositoryRes.status).toBe(200);

      const approvalRequest = {
        requestId: '00000000-0000-4000-8000-000000000024',
        threadId: thread.id,
        turnId: turn.id,
        sourceRef: 'HEAD',
        targetBranch: 'main',
        commitIds: [commitId],
      };

      const approvalRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/repo_default/git-push/approval`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(approvalRequest),
        }
      );

      expect(approvalRes.status).toBe(200);
      const approvalPayload = await approvalRes.json();
      expect(approvalPayload).toMatchObject({
        approval: {
          kind: 'permission',
          status: 'pending',
          threadId: thread.id,
          turnId: turn.id,
        },
      });
      expect(store.getTurn(workspace.id, thread.id, turn.id).status).toBe('awaiting_human');

      execFileSync('git', ['remote', 'remove', 'origin'], {
        cwd: repositoryPath,
        stdio: 'ignore',
      });
      const approvalReplayRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/repo_default/git-push/approval`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(approvalRequest),
        }
      );

      expect(approvalReplayRes.status).toBe(200);
      await expect(approvalReplayRes.json()).resolves.toMatchObject({
        approval: { id: approvalPayload.approval.id },
      });

      const actionCenterRes = await app.request(
        `/api/app/workspaces/${workspace.id}/action-center`
      );
      expect(actionCenterRes.status).toBe(200);
      await expect(actionCenterRes.json()).resolves.toMatchObject({
        items: [
          expect.objectContaining({
            kind: 'approval',
            title: 'Approve Git push to main',
          }),
        ],
      });

      const decisionRes = await app.request(
        `/api/approvals/${approvalPayload.approval.id}/respond`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000025',
            workspaceId: workspace.id,
            threadId: thread.id,
            turnId: turn.id,
            decision: 'granted',
          }),
        }
      );

      expect(decisionRes.status).toBe(200);
      await expect(decisionRes.json()).resolves.toMatchObject({ status: 'granted' });
      expect(store.getTurn(workspace.id, thread.id, turn.id).status).toBe('running');

      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        const decisions = workspaceDb.sqlite
          .prepare(
            `SELECT action, result, approval_id AS approvalId, resource_summary_json AS resourceSummary
             FROM permission_decisions
             WHERE action = 'repo.push'
             ORDER BY created_at ASC`
          )
          .all() as Array<{
          action: string;
          approvalId: string;
          resourceSummary: string;
          result: string;
        }>;

        expect(decisions).toEqual([
          expect.objectContaining({
            action: 'repo.push',
            approvalId: approvalPayload.approval.id,
            result: 'require_approval',
          }),
          expect.objectContaining({
            action: 'repo.push',
            approvalId: approvalPayload.approval.id,
            result: 'allow',
          }),
        ]);
        for (const decision of decisions) {
          expect(JSON.parse(decision.resourceSummary)).toMatchObject({
            commitIds: [commitId],
            remoteIdentity: 'github:openkit/openkit',
            remoteName: 'origin',
            remoteSummary: 'GitHub repository openkit/openkit on origin',
            sourceCommit: commitId,
            sourceRef: 'HEAD',
          });
        }
      } finally {
        workspaceDb.sqlite.close();
      }

      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/openkit/openkit.git'], {
        cwd: repositoryPath,
        stdio: 'ignore',
      });
      writeFileSync(join(repositoryPath, 'STALE.md'), '# Stale source\n');
      execFileSync('git', ['add', 'STALE.md'], { cwd: repositoryPath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'move approved source'], {
        cwd: repositoryPath,
        stdio: 'ignore',
      });
      const staleSourceRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/repo_default/git-push`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000032',
            approvalRequestId: approvalPayload.approval.id,
          }),
        }
      );

      expect(staleSourceRes.status).toBe(404);
      await expect(staleSourceRes.json()).resolves.toMatchObject({
        code: 'git_push_failed',
        message: expect.stringContaining('approval scope mismatch'),
      });

      execFileSync('git', ['reset', '--hard', commitId], {
        cwd: repositoryPath,
        stdio: 'ignore',
      });
      const driftRemotePath = mkdtempSync(join(tmpdir(), 'openkit-git-push-drift-remote-'));
      execFileSync('git', ['init', '--bare'], { cwd: driftRemotePath, stdio: 'ignore' });
      execFileSync('git', ['remote', 'set-url', 'origin', driftRemotePath], {
        cwd: repositoryPath,
        stdio: 'ignore',
      });
      const staleRemoteRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/repo_default/git-push`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000033',
            approvalRequestId: approvalPayload.approval.id,
          }),
        }
      );

      expect(staleRemoteRes.status).toBe(404);
      await expect(staleRemoteRes.json()).resolves.toMatchObject({
        code: 'git_push_failed',
        message: expect.stringContaining('approval scope mismatch'),
      });

      const driftDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        expect(listGitPushRecords(driftDb, workspace.id)).toEqual([]);
        expect(listVaultUseRecords(driftDb)).toEqual([]);
      } finally {
        driftDb.sqlite.close();
      }
      expect(() =>
        execFileSync('git', ['rev-parse', 'refs/heads/main'], {
          cwd: driftRemotePath,
          encoding: 'utf8',
          stdio: 'pipe',
        })
      ).toThrow();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects Git push write operations in the Quick Chat workspace', async () => {
    const coreDb = createCoreDb();
    const app = createApp({ coreDb, turnExecutor: new FakeTurnExecutor() });

    try {
      const approvalRes = await app.request(
        '/api/app/workspaces/ws_quick_chat/repositories/repo_default/git-push/approval',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000030',
            threadId: 'th_quick_chat',
            turnId: 'turn_quick_chat',
            sourceRef: 'HEAD',
            targetBranch: 'main',
            commitIds: ['abc123'],
          }),
        }
      );

      expect(approvalRes.status).toBe(400);
      await expect(approvalRes.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });

      const pushRes = await app.request(
        '/api/app/workspaces/ws_quick_chat/repositories/repo_default/git-push',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000031',
            approvalRequestId: 'ap_quick_chat',
          }),
        }
      );

      expect(pushRes.status).toBe(400);
      await expect(pushRes.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses non-GitHub push URLs despite GitHub request metadata', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Git push execution');
    const thread = store.createThread(workspace.id, 'Publish accepted work');
    const turn = store.createTurn(workspace.id, thread.id, 'Publish accepted work');
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(coreDb.dataRoot, 'server', 'vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 19) });
    vaultUnlockState.backend().store({
      material: 'ghp_vault_push_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github_push',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_push',
      displayName: 'GitHub push token',
      ownerScope: 'server',
      referenceId: 'vault_github_push',
      secretKind: 'github-token',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['gateway-only'],
      grantId: 'grant_github_push',
      lifetime: 'workspace',
      ownerScope: 'workspace',
      policyDecisionId: 'pd_github_push_grant',
      vaultReferenceId: 'vault_github_push',
      workspaceId: workspace.id,
    });
    const app = createApp({
      coreDb,
      store,
      turnExecutor: new FakeTurnExecutor(),
      vaultUnlockState,
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-execution-repo-'));
    const remotePath = mkdtempSync(join(tmpdir(), 'openkit-git-push-execution-remote-'));

    execFileSync('git', ['init', '--bare'], { cwd: remotePath, stdio: 'ignore' });
    execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'repository-local@example.invalid'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Repository Local'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'publishable change'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    const commitId = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      encoding: 'utf8',
    }).trim();

    try {
      const repositoryRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/default`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            displayName: 'Publish repository',
            localPath: repositoryPath,
            git: {
              authorEmail: null,
              authorName: null,
              allowedPushTargets: ['feature/demo'],
              commitOnApply: true,
              vaultGrantRef: 'grant_github_push',
            },
          }),
        }
      );
      expect(repositoryRes.status).toBe(200);

      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordWorkspaceApplyResult(workspaceDb, {
          requestId: '00000000-0000-4000-8000-000000000026',
          result: {
            appliedAt: '2026-07-05T00:00:00.000Z',
            appliedPaths: ['README.md'],
            changeSetId: 'wcs_push_route_1',
            commitIds: [commitId],
            conflictRecords: [],
            id: 'war_push_route_1',
            reviewId: 'swr_push_route_1',
            skippedPaths: [],
            status: 'applied',
            verification: [],
            workspaceId: workspace.id,
          },
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const approvalRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/repo_default/git-push/approval`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000027',
            threadId: thread.id,
            turnId: turn.id,
            sourceRef: commitId,
            targetBranch: 'feature/demo',
            commitIds: [commitId],
          }),
        }
      );
      expect(approvalRes.status).toBe(200);
      const approvalPayload = await approvalRes.json();

      const decisionRes = await app.request(
        `/api/approvals/${approvalPayload.approval.id}/respond`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000028',
            workspaceId: workspace.id,
            threadId: thread.id,
            turnId: turn.id,
            decision: 'granted',
          }),
        }
      );
      expect(decisionRes.status).toBe(200);

      const previousGithubToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_route_secret';
      const pushRes = await (async () => {
        try {
          return await app.request(
            `/api/app/workspaces/${workspace.id}/repositories/repo_default/git-push`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                requestId: '00000000-0000-4000-8000-000000000029',
                approvalRequestId: approvalPayload.approval.id,
              }),
            }
          );
        } finally {
          if (previousGithubToken === undefined) {
            delete process.env.GITHUB_TOKEN;
          } else {
            process.env.GITHUB_TOKEN = previousGithubToken;
          }
        }
      })();

      const pushText = await pushRes.text();
      expect(pushRes.status, pushText).toBe(200);
      const pushPayload = JSON.parse(pushText);
      expect(pushPayload).toMatchObject({
        commitIds: [commitId],
        outcome: 'unsupported-provider',
        remoteSummary: 'Unsupported Git remote on origin',
        reviewIds: ['swr_push_route_1'],
      });
      expect(JSON.stringify(pushPayload)).not.toContain('ghp_route_secret');

      const executeLedger = store
        .listCommandRequests()
        .find((record) => record.command === 'git_push.execute');
      if (!executeLedger) {
        throw new Error('Git push execution ledger was not recorded.');
      }
      executeLedger.expiresAt = '2000-01-01T00:00:00.000Z';
      expect(
        store.listCommandRequests().some((record) => record.command === 'git_push.execute')
      ).toBe(false);
      execFileSync('git', ['remote', 'remove', 'origin'], {
        cwd: repositoryPath,
        stdio: 'ignore',
      });

      const duplicatePushRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/repo_default/git-push`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000034',
            approvalRequestId: approvalPayload.approval.id,
          }),
        }
      );

      expect(duplicatePushRes.status).toBe(200);
      await expect(duplicatePushRes.json()).resolves.toMatchObject({ id: pushPayload.id });
      const duplicatePushDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        expect(listGitPushRecords(duplicatePushDb, workspace.id)).toHaveLength(1);
      } finally {
        duplicatePushDb.sqlite.close();
      }

      const pushReplayRes = await app.request(
        `/api/app/workspaces/${workspace.id}/repositories/repo_default/git-push`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000029',
            approvalRequestId: approvalPayload.approval.id,
          }),
        }
      );

      expect(pushReplayRes.status).toBe(200);
      await expect(pushReplayRes.json()).resolves.toMatchObject({ id: pushPayload.id });

      const vaultUseDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        expect(listVaultUseRecords(vaultUseDb)).toEqual([]);
      } finally {
        vaultUseDb.sqlite.close();
      }
      expect(() =>
        execFileSync('git', ['rev-parse', 'refs/heads/feature/demo'], {
          cwd: remotePath,
          encoding: 'utf8',
          stdio: 'pipe',
        })
      ).toThrow();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lists workspace vault grant injection metadata through App API', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Vault injection metadata route');
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      grantId: 'grant_github_read_route',
      lifetime: 'turn',
      ownerScope: 'workspace',
      policyDecisionId: 'pd_grant_route',
      targetAgentSessionId: 'as_route',
      vaultReferenceId: 'vault_github_read',
      workspaceId: workspace.id,
      now: () => '2026-07-08T00:00:00.000Z',
    });
    createInjectionPlan(coreDb, {
      backendCapabilityRequirement: 'OpenShell provider attachment.',
      expirationBehavior: 'Expires with turn grant.',
      grantId: 'grant_github_read_route',
      injectionVisibility: 'backend-provider',
      packageSnapshotId: 'aepsnap_route',
      planId: 'plan_github_read_route',
      redactionRule: 'Do not expose provider token.',
      revocationBehavior: 'Detach provider.',
      now: () => '2026-07-08T00:01:00.000Z',
    });
    createInjectionReceipt(coreDb, {
      agentSessionId: 'as_route',
      backendSummary: 'OpenShell provider github attached.',
      grantId: 'grant_github_read_route',
      injectedAt: '2026-07-08T00:02:00.000Z',
      planId: 'plan_github_read_route',
      receiptId: 'receipt_github_read_route',
      revocationStatus: 'active',
    });
    const app = createApp({ coreDb, store });

    const grants = await app.request(`/api/app/workspaces/${workspace.id}/vault/grants`);
    const plans = await app.request(`/api/app/workspaces/${workspace.id}/vault/injection-plans`);
    const receipts = await app.request(
      `/api/app/workspaces/${workspace.id}/vault/injection-receipts`
    );

    expect(grants.status, await grants.clone().text()).toBe(200);
    expect(plans.status, await plans.clone().text()).toBe(200);
    expect(receipts.status, await receipts.clone().text()).toBe(200);
    expect(ListWorkspaceVaultGrantsResponseSchema.parse(await grants.json())).toMatchObject({
      items: [{ grantId: 'grant_github_read_route', vaultReferenceId: 'vault_github_read' }],
      workspaceId: workspace.id,
    });
    expect(ListWorkspaceInjectionPlansResponseSchema.parse(await plans.json())).toMatchObject({
      items: [{ grantId: 'grant_github_read_route', planId: 'plan_github_read_route' }],
      workspaceId: workspace.id,
    });
    expect(ListWorkspaceInjectionReceiptsResponseSchema.parse(await receipts.json())).toMatchObject(
      {
        items: [{ planId: 'plan_github_read_route', receiptId: 'receipt_github_read_route' }],
        workspaceId: workspace.id,
      }
    );
    coreDb.sqlite.close();
  });

  it('passes authored manifest source refs from runtime config to worker turn startup', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-authored-source-repository-'));
    const catalog = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          id: 'main-repo',
          kind: 'git',
          displayName: 'Main repository',
          locator: { repositoryResourceId: 'repo_default' },
          access: 'read-write',
          sensitivity: 'internal',
          allowedSlotKinds: ['worktree'],
          status: 'active',
        },
      ],
    });
    const catalogPath = join(
      coreDb.dataRoot,
      'users',
      LOCAL_USER_ID,
      'workspaces',
      'ws_demo',
      'config',
      'data-sources.jsonc'
    );
    const workspaceConfigDir = join(
      coreDb.dataRoot,
      'users',
      LOCAL_USER_ID,
      'workspaces',
      'ws_demo',
      'config'
    );
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot: coreDb.dataRoot,
        agentConfigs: [
          {
            schemaVersion: 1,
            id: 'agent_codex_host',
            displayName: 'Codex Agent',
            runtime: { kind: 'codex', adapter: 'codex-app-server' },
            mode: 'local',
            deployment: { local: {} },
            workspace: {
              inputs: [{ id: 'repo_root', sourceRef: 'main-repo', target: 'repo' }],
            },
          },
        ],
        agentManifests: [
          {
            adapter: 'codex-app-server',
            deployments: ['local'],
            displayName: 'Codex Agent',
            id: 'agent_codex_host',
            kind: 'custom',
            runtime: 'codex',
            version: '0.0.2',
          },
        ],
        workspaceConfigs: [
          {
            userId: LOCAL_USER_ID,
            workspaceId: 'ws_demo',
            path: join(
              coreDb.dataRoot,
              'users',
              LOCAL_USER_ID,
              'workspaces',
              'ws_demo',
              'config',
              'workspace.jsonc'
            ),
            config: {
              schemaVersion: 1,
              workspace: {
                roots: [
                  {
                    id: 'repo_root',
                    kind: 'host-dir',
                    path: 'repo',
                    access: 'read-write',
                    createIfMissing: true,
                  },
                ],
              },
            },
          },
        ],
        workspaceDataSourceCatalogs: [
          {
            userId: LOCAL_USER_ID,
            workspaceId: 'ws_demo',
            path: catalogPath,
            catalog,
          },
        ],
      }),
    });

    mkdirSync(join(repositoryPath, '.git'), { recursive: true });
    mkdirSync(workspaceConfigDir, { recursive: true });
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    try {
      const app = createApp({
        coreDb,
        dataRoot: coreDb.dataRoot,
        store,
        runtimeConfigManager,
        schedulerEpoch: 12,
        turnExecutor: executor,
      });
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Ready repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turnRes = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000212',
          input: 'Work with the authored source',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(turnRes.status).toBe(202);
      expect(executor.startContexts[0]?.workspaceDataSourceCatalog).toMatchObject({
        sources: [
          expect.objectContaining({ id: 'main-repo' }),
          expect.objectContaining({ id: 'repo_default' }),
        ],
      });
      expect(executor.startContexts[0]?.workspaceSourceRefs).toEqual({
        repo_default: 'repo_default',
        repo_root: 'main-repo',
      });
      expect(executor.startContexts[0]?.workspaceRoots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            access: 'read-write',
            id: 'repo_root',
            sourceKind: 'host-dir',
          }),
        ])
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects authored manifest source refs with a blocked data source diagnostic', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new FakeTurnExecutor();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-blocked-source-repository-'));
    const catalog = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          id: 'disabled-repo',
          kind: 'git',
          displayName: 'Disabled repository',
          locator: { repositoryResourceId: 'repo_disabled' },
          access: 'read-write',
          sensitivity: 'internal',
          allowedSlotKinds: ['worktree'],
          status: 'disabled',
        },
      ],
    });
    const workspaceConfigDir = join(
      coreDb.dataRoot,
      'users',
      LOCAL_USER_ID,
      'workspaces',
      'ws_demo',
      'config'
    );
    const catalogPath = join(workspaceConfigDir, 'data-sources.jsonc');
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot: coreDb.dataRoot,
        agentConfigs: [
          {
            schemaVersion: 1,
            id: 'agent_codex_host',
            displayName: 'Codex Agent',
            runtime: { kind: 'codex', adapter: 'codex-app-server' },
            mode: 'local',
            deployment: { local: {} },
            workspace: {
              inputs: [{ id: 'repo_root', sourceRef: 'disabled-repo', target: 'repo' }],
            },
          },
        ],
        agentManifests: [
          {
            adapter: 'codex-app-server',
            deployments: ['local'],
            displayName: 'Codex Agent',
            id: 'agent_codex_host',
            kind: 'custom',
            runtime: 'codex',
            version: '0.0.2',
          },
        ],
        workspaceConfigs: [
          {
            userId: LOCAL_USER_ID,
            workspaceId: 'ws_demo',
            path: join(workspaceConfigDir, 'workspace.jsonc'),
            config: {
              schemaVersion: 1,
              workspace: {
                roots: [
                  {
                    id: 'repo_root',
                    kind: 'host-dir',
                    path: 'repo',
                    access: 'read-write',
                    createIfMissing: true,
                  },
                ],
              },
            },
          },
        ],
        workspaceDataSourceCatalogs: [
          {
            userId: LOCAL_USER_ID,
            workspaceId: 'ws_demo',
            path: catalogPath,
            catalog,
          },
        ],
      }),
    });

    mkdirSync(join(repositoryPath, '.git'), { recursive: true });
    mkdirSync(workspaceConfigDir, { recursive: true });
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    try {
      const app = createApp({
        coreDb,
        dataRoot: coreDb.dataRoot,
        store,
        runtimeConfigManager,
        schedulerEpoch: 12,
        turnExecutor: executor,
      });
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Ready repository',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turnRes = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000213',
          input: 'Work with the blocked source',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const payload = (await turnRes.json()) as Record<string, unknown>;

      expect(turnRes.status).toBe(409);
      expect(payload).toMatchObject({
        code: 'workspace_data_source_blocked',
        message: 'Workspace data source disabled: disabled-repo',
      });
      expect(executor.startContexts).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects worker turns before startup when no repository is configured', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();

    try {
      const app = createApp({ coreDb, turnExecutor: executor });
      const turnRes = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000212',
          input: 'Work without repository setup',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(turnRes.status).toBe(400);
      await expect(turnRes.json()).resolves.toMatchObject({
        code: 'workspace_repository_missing',
        message: 'Workspace repository is not configured.',
      });
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects worker turns before startup when repository validation is not ready', async () => {
    const coreDb = createCoreDb();
    const executor = new FakeTurnExecutor();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-turn-invalid-repository-'));

    try {
      const app = createApp({ coreDb, turnExecutor: executor });
      await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: 'Plain directory',
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
      });

      const turnRes = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000213',
          input: 'Work in an invalid repository',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const payloadText = await turnRes.text();

      expect(turnRes.status).toBe(400);
      expect(JSON.parse(payloadText)).toMatchObject({
        code: 'workspace_repository_not_ready',
        message: expect.stringContaining('is not a git repository directory'),
      });
      expect(payloadText).not.toContain(repositoryPath);
      expect(executor.startContexts).toHaveLength(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns a protocol API error when interrupting with an invalid request body', async () => {
    const app = createApp({ turnExecutor: new FakeTurnExecutor() });
    const res = await app.request(
      '/api/workspaces/ws_demo/threads/th_demo/turns/tu_missing/interrupt',
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('turnId'),
    });
  });

  it('returns a rate-limit API error for quick chat provider 429 responses', async () => {
    const app = createApp({
      openKitConfig: {
        defaults: {
          gatewayModel: 'openai/gpt-5.2',
          gatewayProviderId: 'openrouter',
        },
      },
      providerCredentialResolver: () => 'test-key',
      providerRegistry: new ProviderRegistry([
        {
          baseUrl: 'https://openrouter.ai/api/v1',
          defaultModel: 'openai/gpt-5.2',
          displayName: 'OpenRouter',
          id: 'openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.2'],
          secretRef: 'env:OPENROUTER_API_KEY',
        },
      ]),
      turnExecutor: new FakeTurnExecutor(),
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new OpenAICompatibleProviderError({
            status: 429,
            code: 'rate_limit_exceeded',
            message: 'Rate limit exceeded token=tok_private_rate_limit.',
          });
        },
      } as unknown as PiAiGatewayClient,
    });
    const res = await app.request('/api/app/quick-chat', {
      method: 'POST',
      body: JSON.stringify({
        input: 'hello',
      }),
      headers: { 'content-type': 'application/json' },
    });

    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(429);
    expect(body).toMatchObject({
      code: 'provider_rate_limited',
      message: 'Rate limit exceeded token=[redacted]',
      details: {
        providerCode: 'rate_limit_exceeded',
        providerStatus: 429,
      },
    });
  });

  it('emits SSE events that conform to the shared protocol schema', async () => {
    const store = createDemoStore();
    const app = createApp({ store, turnExecutor: new FakeTurnExecutor() });
    const res = await app.request('/api/turns', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: '0190f4c8-0000-7000-8000-000000000207',
        input: 'Ship the update',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const turn = (await res.json()) as { id: string };

    for (const event of store.getTurnEvents(turn.id)) {
      expect(() => SseEventEnvelopeSchema.parse(event)).not.toThrow();
      expect(event.requestId).toBe('0190f4c8-0000-7000-8000-000000000207');
    }
  });
});
