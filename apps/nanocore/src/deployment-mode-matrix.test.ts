import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEnvironmentPackage,
  AgentEnvironmentValidationDiagnostic,
  WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';
import { createGoalRecord, createGoalTask } from './runtime/goal-store.js';
import { createConfiguredTurnExecutor } from './runtime/turn-executor-factory.js';
import type { TurnExecutor } from './runtime/types.js';
import { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import type {
  WorkerGovernanceArtifactRecord,
  WorkerGovernanceBackend,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceMaterializationContext,
  WorkerGovernanceMaterializationRecord,
  WorkerGovernanceWorkspaceChangeRecord,
} from './runtime/worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './runtime/worker-governance-turn-executor.js';
import type { WorkerTranscriptPayload } from './runtime/worker-transcript.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { upsertWorkspaceRepositoryResource } from './workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** NanoCore product deployment mode used by the six-mode verification matrix. */
type CoreDeploymentMode = 'local' | 'server';

/** Container placement used by the deployment verification matrix. */
type AgentRuntimePlacement = 'local-container' | 'remote-container';

/** One NanoCore deployment matrix case. */
interface DeploymentModeMatrixCase {
  /** NanoCore product mode selected for the app. */
  coreMode: CoreDeploymentMode;
  /** Agent runtime placement selected for the turn executor. */
  runtimePlacement: AgentRuntimePlacement;
}

const MATRIX_CASES: DeploymentModeMatrixCase[] = [
  { coreMode: 'local', runtimePlacement: 'local-container' },
  { coreMode: 'local', runtimePlacement: 'remote-container' },
  { coreMode: 'server', runtimePlacement: 'local-container' },
  { coreMode: 'server', runtimePlacement: 'remote-container' },
];

describe('NanoCore deployment mode matrix', () => {
  it.each(MATRIX_CASES)('boots diagnostics for core=$coreMode runtime=$runtimePlacement', async ({
    coreMode,
    runtimePlacement,
  }) => {
    const turnExecutor = createMatrixTurnExecutor(runtimePlacement);
    const coreDb = coreMode === 'server' ? createCoreDb() : null;

    try {
      let authorization: string | undefined;
      if (coreDb) {
        ensureLocalUser(coreDb);
        const serverAdmin = createOpenKitAccessTokenRecord(coreDb, {
          expiresAt: '2999-01-01T00:00:00.000Z',
          ownerUserId: LOCAL_USER_ID,
          scope: 'server-admin',
          workspaceIds: [],
        });
        authorization = `Bearer ${serverAdmin.secret}`;
      }
      const app = createApp({
        ...(coreMode === 'server'
          ? { auth: createSignedInAuthStub(), coreDb: coreDb!, mode: 'server' }
          : {}),
        agentManifests: [],
        turnExecutor,
      });
      const diagnostics = await app.request('/api/diagnostics', {
        ...(authorization ? { headers: { authorization } } : {}),
      });
      const payload = await diagnostics.json();

      expect(diagnostics.status).toBe(200);
      expect(payload).toMatchObject({
        auth: coreMode === 'server' ? { mode: 'server', signedIn: false } : { mode: 'local' },
        mode: coreMode,
      });
      expect(describeTurnExecutorPlacement(turnExecutor)).toEqual(runtimePlacement);
    } finally {
      coreDb?.sqlite.close();
    }
  });

  it.each(
    MATRIX_CASES
  )('runs one Goal Mode step loop for core=$coreMode runtime=$runtimePlacement', async ({
    coreMode,
    runtimePlacement,
  }) => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', `Loop matrix ${coreMode} ${runtimePlacement}`);
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-loop-matrix-repo-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      seedRepositoryAndGoal(coreDb, thread.id, repositoryPath, runtimePlacement);
      seedThreadContext(store, thread.id, runtimePlacement);
      if (coreMode === 'server') {
        ensureLocalUser(coreDb);
        recordWorkspaceOwnerMembership({
          coreDb,
          ownerUserId: LOCAL_USER_ID,
          workspaceId: 'ws_demo',
        });
      }
      const turnExecutor = createMatrixLoopTurnExecutor(runtimePlacement, coreDb);
      const app = createApp({
        ...(coreMode === 'server' ? { auth: createSignedInAuthStub(), mode: 'server' } : {}),
        coreDb,
        store,
        turnExecutor,
      });
      const response = await app.request(
        `/api/app/workspaces/ws_demo/threads/${thread.id}/goal/step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000301',
          }),
        }
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        decision: {
          outcome: 'review',
          shouldStop: true,
        },
        goal: {
          status: 'reviewing',
          currentTask: {
            status: 'reviewing',
          },
          pendingHumanAttention: {
            required: true,
          },
        },
        pendingAttention: {
          kind: 'review',
        },
        worker: {
          stopReason: 'completed',
          checkpointStage: 'completed',
        },
      });

      const actionCenter = await app.request('/api/app/workspaces/ws_demo/action-center');
      const actionCenterPayload = await actionCenter.json();

      expect(actionCenter.status).toBe(200);
      expect(
        actionCenterPayload.items.some(
          (item: { kind?: string; severity?: string }) =>
            (item.kind === 'artifact_review' || item.kind === 'goal_review') &&
            item.severity === 'needs_input'
        )
      ).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/**
 * Creates a turn executor for one runtime placement without starting a real worker process.
 *
 * @param placement Agent runtime placement to configure.
 * @returns Configured turn executor.
 */
function createMatrixTurnExecutor(placement: AgentRuntimePlacement): TurnExecutor {
  const workerControlGateway = new WorkerControlGateway();

  if (placement === 'local-container') {
    return createConfiguredTurnExecutor({
      env: {
        OPENKIT_CONTAINER_BACKEND: 'openshell',
        OPENKIT_CONTAINER_PLACEMENT: 'local',
        OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL:
          'http://host.openshell.internal:3000/api/worker-control',
        OPENKIT_OPENSHELL_GATEWAY: 'openshell',
        OPENKIT_OPENSHELL_WORKER_IMAGE: 'openkit/worker-codex:dev',
        OPENKIT_WORKER_RUNTIME: 'container',
      },
      workerControlGateway,
    });
  }

  return createConfiguredTurnExecutor({
    env: {
      OPENKIT_CONTAINER_BACKEND: 'openshell',
      OPENKIT_CONTAINER_PLACEMENT: 'remote',
      OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL: 'https://nanocore.example.com/api/worker-control',
      OPENKIT_OPENSHELL_GATEWAY: 'a1-openkit',
      OPENKIT_OPENSHELL_GATEWAY_URL: 'https://a1.example.com:17670',
      OPENKIT_OPENSHELL_WORKER_IMAGE: 'openkit/worker-codex:dev',
      OPENKIT_WORKER_RUNTIME: 'container',
    },
    workerControlGateway,
  });
}

/**
 * Creates a turn executor that exercises the Goal Mode loop path for one placement.
 *
 * @param placement Agent runtime placement to configure.
 * @param coreDb Core database used by worker-governance executors.
 * @returns Turn executor for the matrix loop test.
 */
function createMatrixLoopTurnExecutor(
  placement: AgentRuntimePlacement,
  coreDb: CoreDb
): TurnExecutor {
  return new WorkerGovernanceTurnExecutor({
    backend: new MatrixWorkerGovernanceBackend(runtimeCapabilities(placement)),
    coreDb,
    createAgentSessionId: () => `as_loop_${placement.replace(/-/g, '_')}`,
    environmentBackend:
      placement === 'remote-container'
        ? {
            workerControlBaseUrl: 'https://nanocore.example.com/api/worker-control',
            gatewayUrl: 'https://a1.example.com:17670',
            kind: 'openshell',
            placement: 'remote',
            sandboxImageRef: 'openkit/worker-codex:dev',
          }
        : {
            workerControlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
            kind: 'openshell',
            sandboxImageRef: 'openkit/worker-codex:dev',
          },
    now: () => new Date(Date.now() + 60_000).toISOString(),
  });
}

/**
 * Describes the runtime placement selected by one turn executor.
 *
 * @param executor Configured turn executor.
 * @returns Agent runtime placement selected by configuration.
 */
function describeTurnExecutorPlacement(executor: TurnExecutor): AgentRuntimePlacement {
  if (executor instanceof WorkerGovernanceTurnExecutor) {
    const environmentBackend = (
      executor as unknown as { environmentBackend: { placement?: string } }
    ).environmentBackend;

    return environmentBackend.placement === 'remote' ? 'remote-container' : 'local-container';
  }

  throw new Error(`Unsupported matrix turn executor: ${executor.constructor.name}.`);
}

/**
 * Opens a migrated temporary Core database for deployment matrix tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-deployment-matrix-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Seeds a repository resource and one ready Goal Mode task.
 *
 * @param coreDb Core database to mutate.
 * @param threadId Thread that owns the goal.
 * @param repositoryPath Host-local temporary repository path.
 * @param runtimePlacement Runtime placement label included in the task objective.
 */
function seedRepositoryAndGoal(
  coreDb: CoreDb,
  threadId: string,
  repositoryPath: string,
  runtimePlacement: AgentRuntimePlacement
): void {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, 'ws_demo');
  try {
    applyScopedMigrations(workspaceDb);
    upsertWorkspaceRepositoryResource(workspaceDb, {
      workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
      workspaceId: 'ws_demo',
      displayName: 'Loop matrix repository',
      localPath: repositoryPath,
      now: () => '2026-06-28T00:00:00.000Z',
    });
    createGoalRecord(workspaceDb, {
      workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
      goalId: `goal_loop_${runtimePlacement.replace(/-/g, '_')}`,
      workspaceId: 'ws_demo',
      threadId,
      title: `Loop ${runtimePlacement}`,
      objective: `Run one loop step through ${runtimePlacement}.`,
      status: 'running',
      now: () => '2026-06-28T00:00:00.000Z',
    });
    createGoalTask(workspaceDb, {
      workspaceId: 'ws_demo',
      threadId,
      goalId: `goal_loop_${runtimePlacement.replace(/-/g, '_')}`,
      taskId: `task_loop_${runtimePlacement.replace(/-/g, '_')}`,
      title: `Step ${runtimePlacement}`,
      objective: `Produce reviewable evidence through ${runtimePlacement}.`,
      orderIndex: 0,
      dependsOnTaskIds: [],
      acceptanceCriteria: ['A worker result is available for human review.'],
      contextBudgetTokens: 12_000,
      verificationChecks: [{ kind: 'manual', description: 'Review the matrix worker result.' }],
      status: 'ready',
      now: () => '2026-06-28T00:00:00.000Z',
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Seeds one completed thread item so Goal Mode context preparation has input.
 *
 * @param store Store to mutate.
 * @param threadId Thread that owns the context item.
 * @param runtimePlacement Runtime placement label included in the context.
 */
function seedThreadContext(
  store: FsStore,
  threadId: string,
  runtimePlacement: AgentRuntimePlacement
): void {
  const turn = store.createTurn('ws_demo', threadId, `Context for ${runtimePlacement}`);
  const timestamp = turn.startedAt ?? '2026-06-28T00:00:00.000Z';

  store.createItem({
    id: `it_context_${threadId}_${runtimePlacement.replace(/-/g, '_')}`,
    workspaceId: 'ws_demo',
    threadId,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    text: `Use this context for the ${runtimePlacement} loop matrix step.`,
    createdAt: timestamp,
    completedAt: timestamp,
  });
  store.updateTurn(turn.id, {
    status: 'completed',
    completedAt: timestamp,
    durationMs: 0,
  });
}

/**
 * Returns backend capability declarations for one runtime placement.
 *
 * @param placement Runtime placement to describe.
 * @returns Backend capability list for the fake governance backend.
 */
function runtimeCapabilities(placement: AgentRuntimePlacement): string[] {
  if (placement === 'remote-container') {
    return [
      'container',
      'transcript-sink',
      'remote-gateway',
      'backend-service-readiness',
      'file-upload-download',
      'git-materialization',
      'change-set-collection',
    ];
  }

  return ['container', 'transcript-sink'];
}

/**
 * Worker-governance backend used by deterministic local-container and remote-container loop tests.
 */
class MatrixWorkerGovernanceBackend implements WorkerGovernanceBackend {
  private lastPackage: AgentEnvironmentPackage | null = null;

  /**
   * Creates a fake worker-governance backend.
   *
   * @param capabilities Backend capabilities to report.
   */
  public constructor(private readonly capabilities: string[]) {}

  /**
   * Describes backend capabilities.
   *
   * @returns Capability declaration.
   */
  public async describeCapabilities(): Promise<WorkerGovernanceBackendCapabilities> {
    return {
      capabilities: this.capabilities,
      dynamicCapabilities: [],
      kind: 'openshell',
      version: '0.0.63',
    };
  }

  /**
   * Accepts every generated package in this deterministic matrix.
   *
   * @returns Empty validation diagnostic list.
   */
  public async validatePackage(): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [];
  }

  /**
   * Records the generated package and returns a materialization summary.
   *
   * @param environmentPackage Package generated by NanoCore.
   * @param context Materialization context.
   * @returns Product-safe materialization record.
   */
  public async materialize(
    environmentPackage: AgentEnvironmentPackage,
    _context?: WorkerGovernanceMaterializationContext
  ): Promise<WorkerGovernanceMaterializationRecord> {
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
      workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
        access: input.access,
        id: input.id,
        kind: input.kind,
        target: input.target,
      })),
    };
  }

  /**
   * Emits launch evidence.
   *
   * @returns Launch evidence record.
   */
  public async launch(): Promise<WorkerGovernanceEvidenceRecord> {
    return { data: {}, kind: 'matrix.launch', timestamp: '2026-06-28T00:00:00.000Z' };
  }

  /**
   * Reports dynamic update support as a no-op.
   *
   * @returns Empty validation diagnostic list.
   */
  public async update(): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [];
  }

  /**
   * Returns no extra backend evidence.
   *
   * @returns Empty evidence list.
   */
  public async collectEvidence(): Promise<WorkerGovernanceEvidenceRecord[]> {
    return [];
  }

  /**
   * Returns no provider refresh evidence for this loop matrix.
   *
   * @returns Empty evidence list.
   */
  public async collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]> {
    return [];
  }

  /**
   * Returns a deterministic worker transcript with one message and one artifact.
   *
   * @returns Transcript payload.
   */
  public async collectTranscript(): Promise<WorkerTranscriptPayload> {
    if (!this.lastPackage) {
      throw new Error('Package was not materialized.');
    }

    return {
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
          kind: 'summary',
          mediaType: 'text/markdown',
          path: '/openkit/artifacts/loop-matrix.md',
          title: 'Container loop matrix result',
        },
      })}\n`,
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
          text: 'Container loop matrix worker completed the task.',
        },
      })}\n`,
    };
  }

  /**
   * Returns no workspace changes for this loop matrix.
   *
   * @returns Empty workspace change list.
   */
  public async collectWorkspaceChanges(): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    return [];
  }

  /**
   * Returns no backend-native artifact records.
   *
   * @returns Empty artifact list.
   */
  public async collectArtifacts(): Promise<WorkerGovernanceArtifactRecord[]> {
    return [];
  }

  /**
   * Emits teardown evidence.
   *
   * @returns Teardown evidence record.
   */
  public async teardown(): Promise<WorkerGovernanceEvidenceRecord> {
    return { data: {}, kind: 'matrix.teardown', timestamp: '2026-06-28T00:00:00.000Z' };
  }
}

/**
 * Creates a signed-in Better Auth test double for server-mode matrix checks.
 *
 * @returns Better Auth-compatible server stub.
 */
function createSignedInAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({
        session: { id: 'session_matrix_secret' },
        user: { id: LOCAL_USER_ID },
      }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}
