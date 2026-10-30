import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import {
  StartTaskModeResponseSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { deriveEntityId, workspaceIdForOwner } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import * as knowledgeOwners from './knowledge-operations.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import type { FsStore } from './lib/store.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION } from './lib/store.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import { ProviderRegistry } from './providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  listSchedulerExecutionAttemptsForTurn,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from './runtime/execution-attempt-records.js';
import { listThreadPendingRequests } from './runtime/pending-requests.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from './runtime/scheduler-dispatch-loop.js';
import { createConfiguredWorkerLifecycleRuntime } from './runtime/turn-executor-factory.js';
import type { TurnStartRuntimeContext } from './runtime/types.js';
import {
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './runtime/worker-backend-sessions.js';
import * as checkpointOwners from './runtime/worker-checkpoints.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { getWorkerControlAcceptedFinalStatus } from './runtime/worker-control-records.js';
import type { WorkerGovernanceBackend } from './runtime/worker-governance-backend.js';
import { WorkerGovernanceCapacityUnavailableError } from './runtime/worker-governance-backend.js';
import * as recoveryOwners from './runtime/worker-recovery.js';
import { workerTurnTerminalPublication } from './runtime/worker-turn-failure.js';
import * as loopOwners from './runtime/worker-turn-loop.js';
import { bindWorkerCheckpointToPreparedSession } from './runtime/worker-turn-loop.js';
import {
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
} from './scheduler-records.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { artifactReferenceItemId } from './storage/workspace-file-records.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createApp, createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser } from './test-support/local-user.js';
import {
  confirmTaskRequest,
  conversationBody,
  observeExecutionAttempts,
  SELECTED_CHOICE,
  taskProposalProvider,
} from './test-support/mode-entry-fixture.js';
import { recordTestNativeRuntimeTarget } from './test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from './test-support/native-task-admission.js';
import { operationRequest } from './test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Installs one deliberate checkpoint fault only after native writes drain, then resumes before replay. */
async function mutateQuiescentCheckpoint(mutate: () => { changes: number }): Promise<void> {
  const resume = await getControlStoreWorkerClient().pauseForDataRootBackup();
  try {
    if (mutate().changes !== 1) throw new Error('Checkpoint fault must mutate exactly one row.');
  } finally {
    resume();
  }
}

/** Checks actual native completion authority after the selected-Worker owner has closed out. */
async function assertNativeTaskAdmission(
  coreDb: ReturnType<typeof openCoreDb>,
  store: FsStore,
  turnId: string,
  releaseLost: boolean
) {
  const turn = store.getTurnById(turnId);
  const db = openWorkspaceDb(coreDb.dataRoot, workspaceIdForOwner(turn.owner));
  try {
    const roots = db.sqlite
      .prepare('SELECT id,phase FROM control_executions WHERE work_id=?')
      .all(turnId);
    expect(roots).toEqual([expect.objectContaining({ phase: releaseLost ? 'closing' : 'closed' })]);
    const publication = await workerTurnTerminalPublication(db, turnId);
    expect(publication.execution?.executionId).toBe((roots[0] as { id: string }).id);
    expect(publication.evidence!.length).toBeGreaterThan(0);
    const steps = db.sqlite
      .prepare(
        "SELECT state,json_extract(control_json,'$.kind') AS kind FROM control_execution_steps WHERE execution_id=?"
      )
      .all((roots[0] as { id: string }).id) as { kind: string; state: string }[];
    for (const kind of ['materialize', 'collect', 'inspect-cleanup', 'terminal-publication'])
      expect(steps.find((step) => step.kind === kind)).toMatchObject({ state: 'completed' });
    expect(steps.find((step) => step.kind === 'release')).toMatchObject({
      state: releaseLost ? 'intent' : 'completed',
    });
    expect(
      listThreadPendingRequests(db.sqlite, workspaceIdForOwner(turn.owner), turn.threadId)
    ).toEqual([]);
    expect(
      store.getTurnEvents(turnId).filter((event) => event.event === 'turn.completed')
    ).toHaveLength(1);
    const finalStatuses = coreDb.sqlite
      .prepare(
        "SELECT record_json FROM worker_control_records WHERE turn_id=? AND operation='final_status'"
      )
      .all(turnId) as { record_json: string }[];
    expect(finalStatuses.map((row) => JSON.parse(row.record_json))).toEqual([
      expect.objectContaining({ status: 'completed', stopReason: 'completed' }),
    ]);
    const attempts = observeExecutionAttempts(coreDb).filter(
      (attempt) => attempt.turn_id === turnId
    );
    expect(attempts).toEqual([
      expect.objectContaining({
        phase: releaseLost ? 'closing' : 'closed',
        fence_ref: releaseLost ? null : expect.any(String),
      }),
    ]);
    expect(getWorkerBackendSession(coreDb, String(attempts[0]!.attempt_id))).toMatchObject({
      state: 'cleaned',
      workspaceHandoffState: 'complete',
      physicalCleanedAt: expect.any(String),
    });
  } finally {
    db.sqlite.close();
  }
}
/** Models an accepted completed Worker over real Core preparation without physical Native effects. */
class CompletingTurnExecutor extends SimulatedTurnExecutor {
  /** Uses the same Core authority as the application; pure refusal fixtures may omit it. */
  public constructor(
    protected readonly fixtureOptions: { coreDb?: ReturnType<typeof openCoreDb> } = {}
  ) {
    super(fixtureOptions);
    if (fixtureOptions.coreDb) recordTestNativeRuntimeTarget(fixtureOptions.coreDb);
  }

  /** Binds the exact prepared checkpoint and commits original submit intent before the modeled effect. */
  protected async beginTurn(
    store: FsStore,
    turnId: string,
    context: TurnStartRuntimeContext,
    input: string
  ): Promise<void> {
    const coreDb = this.fixtureOptions.coreDb;
    if (!coreDb || !context.attemptId || !context.agentSessionId)
      throw new Error('Worker fixture lacks exact Core preparation.');
    const turn = store.getTurnById(turnId);
    const db = openWorkspaceDb(coreDb.dataRoot, workspaceIdForOwner(turn.owner));
    try {
      await bindWorkerCheckpointToPreparedSession({
        coreDb,
        workspaceDb: db,
        store,
        workspaceId: workspaceIdForOwner(turn.owner),
        threadId: turn.threadId,
        turnId,
        requestId: context.requestId ?? null,
        agentSessionId: context.agentSessionId,
        attemptId: context.attemptId,
      });
      const environmentPackage = resolveAgentEnvironmentPackage({
        coreDb,
        agentSessionId: context.agentSessionId,
        agentSetup: context.agentSetup!,
        backend: { kind: 'openshell' },
        createdAt: new Date().toISOString(),
        requestId: context.requestId ?? null,
        turn,
        turnInput: input,
        triggerActor: turn.triggerActor,
        workspaceRoots: context.workspaceRoots,
        ...(context.workspaceMcpServerCatalog
          ? { workspaceMcpServerCatalog: context.workspaceMcpServerCatalog }
          : {}),
        ...(context.workspaceDataSourceCatalog
          ? { workspaceDataSourceCatalog: context.workspaceDataSourceCatalog }
          : {}),
        ...(context.workspaceSourceRefs
          ? { workspaceSourceRefs: context.workspaceSourceRefs }
          : {}),
      });
      recordAgentEnvironmentPackageSnapshot(db, {
        environmentPackage,
        createdAt: new Date().toISOString(),
      });
      const target = recordTestNativeRuntimeTarget(coreDb);
      const backendSession = recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: environmentPackage.runtime.image.ref, kind: 'reference' },
        backendVersion: null,
        identity: {
          agentSessionId: context.agentSessionId,
          backendKind: 'openshell',
          backendSessionId: `modeled_${environmentPackage.snapshotId}`,
          deploymentId: target.deploymentId,
          packageSnapshotId: environmentPackage.snapshotId,
          runtimeTargetId: target.targetId,
          stagingDirectoryRef: `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`,
          transientProviderInstanceId: null,
        },
        lineage: { workspaceId: workspaceIdForOwner(turn.owner), threadId: turn.threadId, turnId },
        sandboxBindingRef: requireSchedulerExecutionAttempt(coreDb, context.attemptId).bindingRef!,
      });
      markWorkerBackendWorkspaceHandoffComplete(coreDb, { attemptId: backendSession.attemptId });
      const at = turn.startedAt!;
      const sessionInput = {
        id: context.agentSessionId,
        agentId: turn.agentId!,
        workspaceId: workspaceIdForOwner(turn.owner),
        threadId: turn.threadId,
        status: 'busy',
        message: null,
        createdAt: at,
        updatedAt: at,
        environmentPackageSnapshotId: environmentPackage.snapshotId,
        sessionCompatibilityKey: context.sessionCompatibilityKey,
      } as const;
      let exists = false;
      try {
        store.getAgentSession(context.agentSessionId);
        exists = true;
      } catch {
        /* Fresh prepared session. */
      }
      if (exists)
        await store.updateAgentSession(context.agentSessionId, {
          status: sessionInput.status,
          message: sessionInput.message,
          updatedAt: sessionInput.updatedAt,
          environmentPackageSnapshotId: sessionInput.environmentPackageSnapshotId,
        });
      else await store.createAgentSession(sessionInput);
    } finally {
      db.sqlite.close();
    }
    const attempt = recordSchedulerExecutionOperation(coreDb, {
      attemptId: context.attemptId,
      operationId: `modeled:${turnId}`,
      submission: true,
    });
    acceptSchedulerExecutionObservation(
      coreDb,
      await this.submit({ ...schedulerExecutionCorrelation(attempt), deadline: attempt.deadline! })
    );
    context.onSubmissionSettled?.();
  }

  /** Settles this explicit model's six barriers after its held product/closeout work; it owns no physical resident. */
  protected async releaseTurn(context: TurnStartRuntimeContext): Promise<void> {
    const coreDb = this.fixtureOptions.coreDb!;
    // This test double creates no native process; its exact private cleanup projection settles alongside its owned modeled barriers.
    transitionWorkerBackendSessionState(coreDb, {
      attemptId: context.attemptId!,
      fromState: 'materializing',
      toState: 'cleanup-pending',
    });
    transitionWorkerBackendSessionState(coreDb, {
      attemptId: context.attemptId!,
      fromState: 'cleanup-pending',
      toState: 'physical-cleaned',
    });
    transitionWorkerBackendSessionState(coreDb, {
      attemptId: context.attemptId!,
      fromState: 'physical-cleaned',
      toState: 'cleaned',
    });
    const closing = markSchedulerExecutionAttemptClosing(coreDb, {
      attemptId: context.attemptId!,
      cause: 'turn-completed',
    });
    const correlation = schedulerExecutionCorrelation(closing);
    const proof = {
      terminalHandoff: true,
      output: true,
      evidence: true,
      outsideWorkspaceCollection: true,
      integrationDrain: true,
      routesRevoked: true,
    } as const;
    const result = await this.release({ ...correlation, proof });
    closeSchedulerExecutionAttemptWithFence(coreDb, {
      correlation,
      proof,
      fenceRef: result.fenceRef!,
    });
  }

  /** Captured scheduler start contexts, including the forwarded Worker storage choice. */
  public readonly startContexts: TurnStartRuntimeContext[] = [];

  /**
   * Records the launch context and emits one unique completed Worker outcome.
   *
   * @param store Store that owns the Worker Turn.
   * @param turnId Turn to complete.
   * @param input Worker prompt retained on the assistant Item.
   * @param context Scheduler start context.
   */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    await this.beginTurn(store, turnId, context, input);
    await this.publishCompletedTurn(store, turnId, input, context);
    await this.releaseTurn(context);
  }

  /** Publishes canonical terminal product state; release is decided separately. */
  protected async publishCompletedTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext
  ): Promise<void> {
    this.startContexts.push(context);
    const turn = store.getTurnById(turnId);
    if (!turn.agentId) {
      throw new Error('Conversation worker turn requires a selected agent id.');
    }
    const completedAt = turn.startedAt ?? new Date().toISOString();
    const agentSessionId = context.agentSessionId;
    if (!agentSessionId) throw new Error('The modeled Worker requires its recorded AgentSession.');
    const agentSession = await store.updateAgentSession(agentSessionId, {
      status: 'idle',
      message: null,
      updatedAt: completedAt,
    });
    await store.createItem({
      id: testEntityId('it', `it_assistant_${turnId}`),
      owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
      threadId: turn.threadId,
      turnId,
      type: 'assistant-message',
      status: 'completed',
      text: input,
      createdAt: completedAt,
      completedAt,
    });
    const completedTurn = await store.updateTurn(turnId, {
      agentSessionId: agentSession.id,
      completedAt,
      status: 'completed',
    });
    markSchedulerExecutionAttemptClosing(this.fixtureOptions.coreDb!, {
      attemptId: context.attemptId!,
      cause: 'turn-completed',
      outcomeRef: `turn:${turnId}:completed`,
    });
    store.emitTurnEvent(
      turnId,
      {
        event: 'turn.completed',
        requestId: context.requestId ?? null,
        workspaceId: workspaceIdForOwner(turn.owner),
        threadId: turn.threadId,
        turnId,
        data: { type: 'turn-completed', stopReason: 'completed', turn: completedTurn },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
  }
}

/**
 * Holds `startTurn` unresolved until the test releases completion.
 *
 * The conversation.submit route already reaches this executor. Holding completion lets the test observe whether that route accepts the durable Worker tuple before Worker closeout.
 */
class HoldingTurnExecutor extends CompletingTurnExecutor {
  /** Uses the fixture-owned data root to inspect committed admission bytes. */
  public constructor(private readonly fixtureCoreDb: ReturnType<typeof openCoreDb>) {
    super({ coreDb: fixtureCoreDb });
  }
  /** Number of actual executor entries, including unresolved launches. */
  public launches = 0;
  /** Holds the original submit response for the data-root admission exclusion regression. */
  public holdSubmitResponse = false;
  /** Models an accepted response whose settlement is delayed, without replaying submission. */
  public override async submit(input: Parameters<SimulatedTurnExecutor['submit']>[0]) {
    const result = await super.submit(input);
    if (this.holdSubmitResponse) {
      this.launched.resolve();
      await this.completion.promise;
    }
    return result;
  }
  /** Checkpoint observed at executor entry, before completion or response delivery. */
  public checkpointAtLaunch: ReturnType<typeof getWorkerCheckpoint> = null;
  /** Exact request bytes received by the held executor before completion. */
  public readonly inputs: string[] = [];
  /** Controlled closeout failure after canonical completion. */
  public failCloseout = false;
  /** Resolves once the route has invoked `startTurn`. */
  public readonly launched = Promise.withResolvers<void>();
  /** Resolves when the test allows Worker closeout. */
  public readonly completion = Promise.withResolvers<void>();
  /** Resolves after closeout finishes or fails. */
  public readonly finished = Promise.withResolvers<void>();

  /**
   * Signals launch, waits for the test release, then emits the completed Worker outcome.
   *
   * @param store Store that owns the Worker Turn.
   * @param turnId Turn to complete after release.
   * @param input Worker prompt retained on the assistant Item.
   * @param context Scheduler start context.
   */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    const launchedTurn = store.getTurnById(turnId);
    this.launches += 1;
    this.inputs.push(input);
    try {
      await this.beginTurn(store, turnId, context, input);
      const checkpointDb = openWorkspaceDb(
        this.fixtureCoreDb.dataRoot,
        workspaceIdForOwner(launchedTurn.owner)
      );
      try {
        this.checkpointAtLaunch = getWorkerCheckpoint(
          checkpointDb,
          workspaceIdForOwner(launchedTurn.owner),
          launchedTurn.threadId,
          turnId
        );
      } finally {
        checkpointDb.sqlite.close();
      }
      this.launched.resolve();
      await this.completion.promise;
      const turn = store.getTurnById(turnId);
      const at = turn.startedAt ?? new Date().toISOString();
      await store.createItem({
        id: deriveEntityId('it', ['task-user', turnId]),
        owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
        threadId: turn.threadId,
        turnId,
        type: 'user-message',
        status: 'completed',
        text: input,
        actor: turn.triggerActor,
        createdAt: at,
        completedAt: at,
      });
      await this.publishCompletedTurn(store, turnId, input, context);
      if (this.failCloseout) throw new Error('Controlled worker closeout failure.');
      await this.releaseTurn(context);
    } finally {
      this.finished.resolve();
    }
  }
}

/**
 * Computes the canonical SHA-256 digest for exact UTF-8 Artifact content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase digest with the required prefix.
 */
function artifactDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Creates one imported Markdown Artifact visible to conversation attachment.
 *
 * @param store Store that owns Demo Workspace artifacts.
 * @param input Artifact identity and body.
 * @returns Created Artifact.
 */
function createImportedMarkdownArtifact(
  store: FsStore,
  input: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly requestId: string;
  }
): ReturnType<FsStore['createArtifact']> {
  const timestamp = new Date().toISOString();
  const contentDigest = artifactDigest(input.body);
  return store.createArtifact({
    id: input.id,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: null,
    turnId: null,
    kind: 'file',
    title: input.title,
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'markdown', body: input.body },
    contentDigest,
    lastMutationRequestId: input.requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: input.requestId,
      sourceDigest: contentDigest,
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      requestId: input.requestId,
      recordedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/**
 * Expected durable Artifact-reference Item fields for one accepted conversation Turn.
 *
 * @param input Artifact snapshot, conversation request id, and owning Turn.
 * @returns Matcher fields preserved through acceptance and replay.
 */
function expectedArtifactReferenceItem(input: {
  readonly artifact: ReturnType<FsStore['createArtifact']>;
  readonly requestId: string;
  readonly turnId: string;
}) {
  return {
    artifactId: input.artifact.id,
    artifactVersion: input.artifact.version,
    id: artifactReferenceItemId(input.artifact.id, input.turnId),
    lastMutationRequestId: input.requestId,
    status: 'completed',
    summary: input.artifact.summary,
    title: input.artifact.title,
    type: 'artifact-reference',
  };
}

describe('conversation.submit worker storage choice', () => {
  it('rejects oversized objectives before worker effects and starts the exact 2000-character boundary', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-conversation-objective-limit-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const native = createNativeTaskAdmissionFixture(coreDb, store);
    const executor = native.executor;
    const itemPublications: {
      itemId: string;
      input: Parameters<typeof store.updateItem>[1];
      completion: ReturnType<typeof store.updateItem>;
    }[] = [];
    const updateItem = store.updateItem.bind(store);
    const publicationObservation = vi.spyOn(store, 'updateItem').mockImplementation((...args) => {
      const completion = updateItem(...args);
      itemPublications.push({ itemId: args[0], input: args[1], completion });
      return completion;
    });
    const workerLoops: ReturnType<typeof loopOwners.runWorkerTurnLoop>[] = [];
    const originalLoop = loopOwners.runWorkerTurnLoop;
    const loopObservation = vi.spyOn(loopOwners, 'runWorkerTurnLoop').mockImplementation((args) => {
      const pending = originalLoop(args);
      if (args.store === store) workerLoops.push(pending);
      return pending;
    });
    const workerSetup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const app = createAppWithWorkspaceAuthority({
      agentManifests: [workerSetup.manifest],
      coreDb,
      dataRoot,
      fileAdmission: native.fileAdmission,
      workerControlGateway: native.workerControlGateway,
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: executor,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const threadsBefore = store.listThreads('ws_00000000-0000-7000-8000-000000000001');
    const submit = (input: string, requestId: string) =>
      app.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            body: conversationBody({ input, requestId, targetRef: 'new-task-worker' }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );

    try {
      const rejected = await submit('x'.repeat(2073), '0190f4c8-0000-7000-8000-000000000601');
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({
        code: 'invalid_request',
      });
      expect(store.listThreads('ws_00000000-0000-7000-8000-000000000001')).toEqual(threadsBefore);
      for (const thread of threadsBefore) {
        expect(store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', thread.id)).toEqual(
          []
        );
      }
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).toEqual([]);
      expect(executor.launches).toBe(0);

      const input = 'x'.repeat(2000);
      const response = await submit(input, '0190f4c8-0000-7000-8000-000000000602');
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = SubmitConversationResponseSchema.parse(await response.json());
      const workerScope = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: accepted.turn.threadId,
        turnId: accepted.turn.id,
      };
      const createdThreads = store
        .listThreads(workerScope.workspaceId)
        .filter((thread) => !threadsBefore.some((before) => before.id === thread.id));
      expect(createdThreads).toEqual([
        expect.objectContaining({
          id: workerScope.threadId,
          parentThreadId: 'th_00000000-0000-7000-8000-000000000001',
          visibility: 'workspace',
        }),
      ]);
      expect(store.listThreadTurns(workerScope.workspaceId, workerScope.threadId)).toHaveLength(1);
      expect(accepted.turn.agentId).toBe(workerSetup.manifest.id);
      await executor.launched.promise;
      // Task structured input preserves every accepted objective byte through native delivery.
      expect(JSON.parse(executor.inputs[0]!).objective).toBe(input);
      executor.completion.resolve();
      await executor.execution;
      await Promise.all(workerLoops);
      await vi.waitFor(() => {
        const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, workerScope);
        expect(attempts.length).toBeGreaterThan(0);
        expect(attempts.every((attempt) => attempt.phase === 'closed')).toBe(true);
        expect(
          itemPublications.some(
            (publication) =>
              publication.itemId === accepted.item.id &&
              'level' in publication.input &&
              publication.input.level === 'info'
          )
        ).toBe(true);
      });
      await Promise.all(itemPublications.map((publication) => publication.completion));
      const completed = await app.request(...operationRequest('turn.read', workerScope));
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({ id: workerScope.turnId, status: 'completed' });
      expect(executor.launches).toBe(1);
    } finally {
      executor.completion.resolve();
      try {
        // Always join the actual loop, including when an earlier assertion or execution failed.
        await Promise.allSettled([
          ...(executor.launches ? [executor.execution] : []),
          ...workerLoops,
        ]);
        await Promise.allSettled(itemPublications.map((publication) => publication.completion));
      } finally {
        publicationObservation.mockRestore();
        if (loopOwners.runWorkerTurnLoop === loopObservation) loopObservation.mockRestore();
        await shutdownControlStoreWorkerClient();
        await native.restore();
        coreDb.sqlite.close();
        rmSync(dataRoot, { force: true, recursive: true });
      }
    }
  });

  it('rejects a supplied choice on an inapplicable target before effects', async () => {
    const store = await createDemoStore();
    const workerSetup = createTestAgentSetup();
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Running worker'
    );
    await store.createAgentSession({
      id: 'as_00000000-0000-713e-88a7-b182503728ab',
      agentId: workerSetup.manifest.id,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: thread.id,
      status: 'ready',
      message: null,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    });
    const app = createAppWithWorkspaceAuthority({
      agentManifests: [workerSetup.manifest],
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: new CompletingTurnExecutor(),
    });

    const assistantRes = await app.request(
      ...operationRequest(
        'conversation.submit',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          body: conversationBody({
            input: 'Answer from Assistant.',
            requestId: 'req_choice_assistant',
            targetRef: 'internal-role:assistant',
            workerStorageChoice: SELECTED_CHOICE,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(assistantRes.status).toBe(409);
    await expect(assistantRes.json()).resolves.toMatchObject({
      code: 'worker_storage_choice_not_applicable',
    });
    expect(
      store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual([]);
    expect(store.listCommandRequests()).toEqual([]);

    const runningRes = await app.request(
      ...operationRequest(
        'conversation.submit',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: thread.id },
        {
          body: conversationBody({
            input: 'Continue this Worker.',
            requestId: 'req_choice_running',
            targetRef: `running-worker:${encodeURIComponent(thread.id)}:${encodeURIComponent(workerSetup.manifest.id)}`,
            workerStorageChoice: { kind: 'fresh' },
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    expect(runningRes.status).toBe(409);
    await expect(runningRes.json()).resolves.toMatchObject({
      code: 'worker_storage_choice_not_applicable',
    });
    expect(store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', thread.id)).toEqual([]);
  });

  it('forwards the exact choice on new-task-worker and conflicts when the choice changes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-conversation-storage-choice-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const executor = new CompletingTurnExecutor({ coreDb });
    const workerSetup = createTestAgentSetup();
    const app = createAppWithWorkspaceAuthority({
      agentManifests: [workerSetup.manifest],
      coreDb,
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: executor,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const requestId = '0190f4c8-0000-7000-8000-000000000401';
    const input = 'Implement the focused Task Mode fix.';
    const body = conversationBody({
      input,
      requestId,
      targetRef: 'new-task-worker',
      workerStorageChoice: SELECTED_CHOICE,
    });

    const loops = vi.spyOn(loopOwners, 'runWorkerTurnLoop');
    const publications = vi.spyOn(store, 'updateItem');
    try {
      const response = await app.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            body,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = SubmitConversationResponseSchema.parse(await response.json());
      const receipts = structuredClone(store.listCommandRequests());
      expect(receipts).toContainEqual(
        expect.objectContaining({
          command: 'conversation.submit',
          requestId,
          response: expect.objectContaining({
            kind: 'turn',
            id: accepted.turn.id,
          }),
        })
      );
      const threadIds = store.listThreads(accepted.receivingWorkspaceId).map((thread) => thread.id);
      await vi.waitFor(() => expect(executor.startContexts).toHaveLength(1));
      const admittedChoice = { ...SELECTED_CHOICE, goalId: null, taskId: null };
      expect(executor.startContexts[0]?.workerStorageChoice).toEqual(admittedChoice);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['admitted'],
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).toEqual([expect.objectContaining({ workerStorageChoice: admittedChoice })]);

      const replay = await app.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            body,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      expect(replay.status, await replay.clone().text()).toBe(202);
      const replayed = SubmitConversationResponseSchema.parse(await replay.json());
      // Replay preserves lineage; the receiving Worker's Items can advance after the response.
      expect(replayed).toMatchObject({
        outcome: accepted.outcome,
        handoff: accepted.handoff,
        originatingWorkspaceId: accepted.originatingWorkspaceId,
        originatingThreadId: accepted.originatingThreadId,
        receivingWorkspaceId: accepted.receivingWorkspaceId,
        receivingThreadId: accepted.receivingThreadId,
        targetRef: accepted.targetRef,
        logicalModelId: accepted.logicalModelId,
        turn: {
          id: accepted.turn.id,
          owner: accepted.turn.owner,
          threadId: accepted.turn.threadId,
          triggerActor: accepted.turn.triggerActor,
          agentId: accepted.turn.agentId,
        },
        item: {
          id: accepted.item.id,
          owner: accepted.item.owner,
          threadId: accepted.item.threadId,
          turnId: accepted.item.turnId,
          type: accepted.item.type,
          createdAt: accepted.item.createdAt,
        },
      });
      expect(executor.startContexts).toHaveLength(1);

      const conflict = await app.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            body: conversationBody({
              input,
              requestId,
              targetRef: 'new-task-worker',
              workerStorageChoice: { kind: 'fresh' },
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });
      expect(executor.startContexts).toHaveLength(1);
      expect(store.listCommandRequests()).toEqual(expect.arrayContaining(receipts));
      expect(store.listCommandRequests()).toHaveLength(receipts.length);
      expect(store.listThreads(accepted.receivingWorkspaceId).map((thread) => thread.id)).toEqual(
        expect.arrayContaining(threadIds)
      );
      expect(store.listThreads(accepted.receivingWorkspaceId)).toHaveLength(threadIds.length);
      expect(
        store
          .listThreadTurns(accepted.receivingWorkspaceId, accepted.receivingThreadId)
          .map((turn) => turn.id)
      ).toEqual([accepted.turn.id]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
          workspaceId: accepted.receivingWorkspaceId,
        })
      ).toEqual([
        expect.objectContaining({
          turnId: accepted.turn.id,
          threadId: accepted.receivingThreadId,
          workerStorageChoice: admittedChoice,
        }),
      ]);
    } finally {
      await Promise.allSettled(
        loops.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value)
      );
      await Promise.allSettled(
        publications.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value)
      );
      publications.mockRestore();
      if (loopOwners.runWorkerTurnLoop === loops) loops.mockRestore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});

describe('conversation.submit worker acceptance wait', () => {
  it('accepts the durable running Worker tuple with a historical pinned Artifact before completion', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-conversation-accept-before-complete-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const native = createNativeTaskAdmissionFixture(coreDb, store);
    const executor = native.executor;
    const itemPublications: {
      itemId: string;
      input: Parameters<typeof store.updateItem>[1];
      completion: ReturnType<typeof store.updateItem>;
    }[] = [];
    const updateItem = store.updateItem.bind(store);
    const publicationObservation = vi.spyOn(store, 'updateItem').mockImplementation((...args) => {
      const completion = updateItem(...args);
      itemPublications.push({ itemId: args[0], input: args[1], completion });
      return completion;
    });
    const workerLoops: ReturnType<typeof loopOwners.runWorkerTurnLoop>[] = [];
    const originalLoop = loopOwners.runWorkerTurnLoop;
    const loopObservation = vi.spyOn(loopOwners, 'runWorkerTurnLoop').mockImplementation((args) => {
      const pending = originalLoop(args);
      if (args.store === store) workerLoops.push(pending);
      return pending;
    });
    const workerSetup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const app = createAppWithWorkspaceAuthority({
      agentManifests: [workerSetup.manifest],
      coreDb,
      dataRoot,
      fileAdmission: native.fileAdmission,
      workerControlGateway: native.workerControlGateway,
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: executor,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const requestId = '0190f4c8-0000-7000-8000-000000000501';
    const artifact = createImportedMarkdownArtifact(store, {
      id: 'ar_00000000-0000-7659-a019-91948394f91d',
      title: 'Task context',
      body: 'Read this material.',
      requestId,
    });
    const artifactRefs = [{ artifactId: artifact.id, artifactVersion: artifact.version }];

    const publicationThread = await store.createThread(
      artifact.workspaceId,
      'Advance selected Artifact'
    );
    await store.commitArtifactVersion({
      workspaceId: artifact.workspaceId,
      threadId: publicationThread.id,
      artifactId: artifact.id,
      expectedArtifactVersion: 1,
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      requestId: '0190f4c8-0000-7000-8000-000000000502',
      recordedAt: new Date().toISOString(),
      title: 'Later context',
      summary: null,
      content: { format: 'text', body: 'This newer version must not replace selected v1.' },
    });

    const replayAcceptedRequest = (targetApp = app) =>
      targetApp.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            body: conversationBody({
              artifactRefs,
              input: 'Keep this Task Worker running.',
              requestId,
              targetRef: 'new-task-worker',
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
    const pending = replayAcceptedRequest();

    try {
      await Promise.race([
        executor.launched.promise,
        pending.then(async (response) => {
          if (response.status === 202) return executor.launched.promise;
          throw new Error(
            `Submission returned before Worker launch: ${response.status} ${await response.text()}`
          );
        }),
      ]);
      const receivingThreads = store
        .listThreads('ws_00000000-0000-7000-8000-000000000001')
        .filter((thread) => thread.parentThreadId === 'th_00000000-0000-7000-8000-000000000001');
      expect(receivingThreads).toHaveLength(1);
      const receiving = receivingThreads[0]!;
      const workerTurn = store
        .listThreadTurns('ws_00000000-0000-7000-8000-000000000001', receiving.id)
        .at(-1);
      expect(workerTurn?.status).toBe('running');

      let acceptedBeforeRelease = false;
      let closedBeforeRelease = false;
      void pending.then(() => {
        acceptedBeforeRelease = true;
      });
      void executor.finished.promise.then(() => {
        closedBeforeRelease = true;
      });
      await setImmediate();
      expect(acceptedBeforeRelease).toBe(true);
      expect(closedBeforeRelease).toBe(false);

      const workerScope = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: workerTurn!.threadId,
        turnId: workerTurn!.id,
      };
      const currentAttempt = listSchedulerExecutionAttemptsForTurn(coreDb, workerScope).find(
        (attempt) => attempt.agentSessionId === workerTurn!.agentSessionId
      );
      expect(
        currentAttempt,
        'The launched Turn must have its exact durable attempt.'
      ).toBeDefined();
      expect(executor.checkpointAtLaunch).toMatchObject({
        stage: 'running_worker',
        workerSessionId: currentAttempt!.agentSessionId,
        stopReason: null,
      });
      // Artifact history and pinned Context input resolve v1 after the current head advances (S16).
      expect(store.getArtifact(artifact.workspaceId, artifact.id).version).toBe(2);
      const delivered = JSON.parse(executor.inputs[0]!);
      expect(delivered.objective).toBe('Keep this Task Worker running.');
      expect(delivered.contextRefs).toContainEqual({
        kind: 'artifact',
        id: artifact.id,
        artifactVersion: artifact.version,
      });
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = SubmitConversationResponseSchema.parse(await response.json());
      expect(accepted.turn.items).toContainEqual(
        expect.objectContaining(
          expectedArtifactReferenceItem({ artifact, requestId, turnId: accepted.turn.id })
        )
      );
      expect(accepted).toMatchObject({
        outcome: 'accepted',
        receivingThreadId: receiving.id,
        turn: expect.objectContaining({ id: workerTurn!.id }),
      });
      expect(
        store.getCommandRequest('conversation.submit', requestId, {
          actorId: 'usr_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).toMatchObject({
        command: 'conversation.submit',
        requestId,
        response: expect.objectContaining({
          kind: 'turn',
          id: workerTurn!.id,
          conversationMetadata: expect.objectContaining({
            resultKind: 'worker-turn',
            status: 202,
          }),
        }),
      });
      expect(['pending', 'running']).toContain(accepted.turn.status);
      const originReferences = () =>
        store
          .listThreadItems(workerScope.workspaceId, 'th_00000000-0000-7000-8000-000000000001')
          .filter((item) => item.type === 'status' && item.causationId === accepted.turn.id);
      expect(originReferences()).toHaveLength(1);
      expect(originReferences()[0]).toMatchObject({
        type: 'status',
        status: 'completed',
        summary: expect.stringContaining(receiving.id),
      });
      const originReference = structuredClone(originReferences()[0]);
      const receipt = structuredClone(
        store.getCommandRequest('conversation.submit', requestId, {
          actorId: 'usr_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          workspaceId: workerScope.workspaceId,
        })
      );
      const replay = await replayAcceptedRequest();
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(SubmitConversationResponseSchema.parse(await replay.json())).toEqual(
        SubmitConversationResponseSchema.parse({
          ...accepted,
          turn: store.getTurnById(accepted.turn.id),
          item: store
            .listThreadItems('ws_00000000-0000-7000-8000-000000000001', accepted.turn.threadId)
            .find((item) => item.id === accepted.item.id),
        })
      );
      expect(
        store
          .listWorkspaceItemRevisions('ws_00000000-0000-7000-8000-000000000001')
          .filter((item) => item.id === accepted.item.id)
      ).toHaveLength(1);
      await store.updateItem(accepted.item.id, { title: 'Worker Turn failed' });
      const contradictedReplay = await replayAcceptedRequest();
      expect(contradictedReplay.status).toBe(409);
      await expect(contradictedReplay.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      await store.updateItem(accepted.item.id, { title: accepted.item.title });
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      const checkpoint = getWorkerCheckpoint(
        workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001',
        receiving.id,
        accepted.turn.id
      )!;
      try {
        // Deliberately contradict the already admitted request; setup used only real owners.
        await mutateQuiescentCheckpoint(() =>
          workspaceDb.sqlite
            .prepare(
              'UPDATE worker_turn_checkpoints SET request_input_hash = ? WHERE checkpoint_id = ?'
            )
            .run('0'.repeat(64), checkpoint.checkpointId)
        );
        const replay = await replayAcceptedRequest();
        expect(replay.status).toBe(409);
        await expect(replay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      } finally {
        await mutateQuiescentCheckpoint(() =>
          workspaceDb.sqlite
            .prepare(
              'UPDATE worker_turn_checkpoints SET request_input_hash = ? WHERE checkpoint_id = ?'
            )
            .run(checkpoint.requestInputHash, checkpoint.checkpointId)
        );
        workspaceDb.sqlite.close();
      }
      expect((await replayAcceptedRequest()).status).toBe(202);
      expect(
        store.getCommandRequest('conversation.submit', requestId, {
          actorId: 'usr_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          workspaceId: workerScope.workspaceId,
        })
      ).toEqual(receipt);
      // Task exact replay preserves one receiving Task, admission and native launch.
      expect(executor.launches).toBe(1);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: workerScope.workspaceId,
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(1);
      expect(
        store
          .listThreads(workerScope.workspaceId)
          .filter((thread) => thread.parentThreadId === 'th_00000000-0000-7000-8000-000000000001')
          .map((thread) => thread.id)
      ).toEqual([receiving.id]);
      expect(store.listThreadTurns(workerScope.workspaceId, receiving.id)).toHaveLength(1);
      executor.completion.resolve();
      await executor.execution;
      await Promise.all(workerLoops);
      await vi.waitFor(() => {
        const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, workerScope);
        expect(attempts.length).toBeGreaterThan(0);
        expect(attempts.every((attempt) => attempt.phase === 'closed')).toBe(true);
        expect(
          itemPublications.some(
            (publication) =>
              publication.itemId === accepted.item.id &&
              'level' in publication.input &&
              publication.input.level === 'info'
          )
        ).toBe(true);
      });
      await Promise.all(itemPublications.map((publication) => publication.completion));
      const completed = await app.request(...operationRequest('turn.read', workerScope));
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({ id: workerScope.turnId, status: 'completed' });
      const reloaded = await createDemoStore({ dataRoot });
      const restarted = createAppWithWorkspaceAuthority({
        agentManifests: [workerSetup.manifest],
        coreDb,
        dataRoot,
        fileAdmission: native.fileAdmission,
        workerControlGateway: native.workerControlGateway,
        openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
        store: reloaded,
        turnExecutor: executor,
      });
      const replayAfterRestart = await replayAcceptedRequest(restarted);
      expect(replayAfterRestart.status, await replayAfterRestart.clone().text()).toBe(202);
      expect(
        reloaded
          .listThreadItems(workerScope.workspaceId, 'th_00000000-0000-7000-8000-000000000001')
          .filter((item) => item.type === 'status' && item.causationId === accepted.turn.id)
      ).toEqual([originReference]);
      expect(reloaded.listThreadTurns(workerScope.workspaceId, receiving.id)).toHaveLength(1);
      expect(executor.launches).toBe(1);
    } finally {
      executor.completion.resolve();
      await pending.catch(() => undefined);
      try {
        await Promise.allSettled([
          ...(executor.launches ? [executor.execution] : []),
          ...workerLoops,
        ]);
        await Promise.allSettled(itemPublications.map((publication) => publication.completion));
      } finally {
        publicationObservation.mockRestore();
        if (loopOwners.runWorkerTurnLoop === loopObservation) loopObservation.mockRestore();
        await shutdownControlStoreWorkerClient();
        await native.restore();
        coreDb.sqlite.close();
        rmSync(dataRoot, { force: true, recursive: true });
      }
    }
  });

  it.each([
    false,
    true,
  ])('replays the original failed Task after native image preparation refusal only when cleanup completes (%s)', async (cleanupFails) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-image-refusal-'));
    const coreDb = openCoreDb(dataRoot);
    const fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000n);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const setup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    recordTestNativeRuntimeTarget(coreDb);
    const effect = vi.fn(async (request: { kind: string }) => {
      expect(request.kind).toBe('image.acquire');
      throw new Error('Controlled native image preparation refusal.');
    });
    const runtime = createConfiguredWorkerLifecycleRuntime({
      fileAdmission,
      coreDb,
      store,
      env: {},
      nanoHostSessionDispatch: {
        effect,
        async poll() {
          return null;
        },
        async result() {},
        async route() {
          throw new Error('No native route.');
        },
      },
    });
    const started = Promise.withResolvers<{ turnId: string; completion: Promise<void> }>();
    const startTurn = runtime.turnExecutor.startTurn.bind(runtime.turnExecutor);
    let completion: Promise<void> | undefined;
    const execution = vi.spyOn(runtime.turnExecutor, 'startTurn').mockImplementation((...args) => {
      completion = startTurn(...args);
      started.resolve({ turnId: args[1], completion });
      return completion;
    });
    const backend = (runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend })
      .backend;
    if (cleanupFails)
      vi.spyOn(backend, 'cleanupSession').mockRejectedValue(new Error('Cleanup is unproved.'));
    const app = createAppWithWorkspaceAuthority({
      fileAdmission,
      coreDb,
      dataRoot,
      store,
      turnExecutor: runtime.turnExecutor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    const submit = () =>
      app.request(
        ...operationRequest(
          'task.start',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000699',
              input: 'Implement one bounded change.',
            }),
          }
        )
      );
    try {
      const accepted = await submit();
      expect(accepted.status, await accepted.clone().text()).toBe(202);
      const original = await accepted.json();
      // Admission does not await asynchronous Context Package preparation or failure publication.
      const observed = await started.promise;
      expect(observed.turnId).toBe(original.turn.id);
      await expect(observed.completion).rejects.toThrow(
        'Controlled native image preparation refusal.'
      );
      await vi.waitFor(() => expect(store.getTurnById(original.turn.id).status).toBe('failed'));
      await vi.waitFor(() =>
        expect(runtime.turnExecutor.isTurnExecutionActive?.(original.turn.id)).toBe(false)
      );
      const before = observeExecutionAttempts(coreDb);
      expect(effect).toHaveBeenCalledOnce();
      const replay = await submit();
      expect(replay.status, await replay.clone().text()).toBe(cleanupFails ? 409 : 202);
      if (cleanupFails)
        await expect(replay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      else
        expect(StartTaskModeResponseSchema.parse(await replay.json())).toMatchObject({
          state: 'failed',
          turn: { id: original.turn.id, status: 'failed' },
        });
      expect(observeExecutionAttempts(coreDb)).toEqual(before);
      expect(effect).toHaveBeenCalledOnce();
      expect(
        store.listThreadAgentSessions(
          'ws_00000000-0000-7000-8000-000000000001',
          original.turn.threadId
        )
      ).toHaveLength(1);
    } finally {
      await completion?.catch(() => undefined);
      execution.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it.each([
    false,
    true,
  ])('preserves failure owners after acceptance (projection failure: %s)', async (projectionFailure) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-conversation-accept-failure-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const native = createNativeTaskAdmissionFixture(coreDb, store);
    const executor = native.executor;
    const workerLoops: ReturnType<typeof loopOwners.runWorkerTurnLoop>[] = [];
    const originalLoop = loopOwners.runWorkerTurnLoop;
    const loopObservation = vi.spyOn(loopOwners, 'runWorkerTurnLoop').mockImplementation((args) => {
      const pending = originalLoop(args);
      if (args.store === store) workerLoops.push(pending);
      return pending;
    });
    const workerSetup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const app = createAppWithWorkspaceAuthority({
      agentManifests: [workerSetup.manifest],
      coreDb,
      dataRoot,
      fileAdmission: native.fileAdmission,
      workerControlGateway: native.workerControlGateway,
      store,
      turnExecutor: executor,
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const requestId = '0190f4c8-0000-7000-8000-000000000502';
    const artifact = createImportedMarkdownArtifact(store, {
      id: 'ar_00000000-0000-74d6-92c6-39a9c2b53457',
      title: 'Task context',
      body: 'Keep this context.',
      requestId,
    });
    const body = conversationBody({
      input: 'Keep this Task Worker running.',
      requestId,
      targetRef: 'new-task-worker',
      artifactRefs: [{ artifactId: artifact.id, artifactVersion: artifact.version }],
    });
    const submit = () =>
      app.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            body,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
    let accepted: ReturnType<typeof SubmitConversationResponseSchema.parse> | undefined;
    const itemPublications: {
      itemId: string;
      turnStatus: string | undefined;
      completion: ReturnType<typeof store.updateItem>;
    }[] = [];
    const updateItem = store.updateItem.bind(store);
    const publicationObservation = vi.spyOn(store, 'updateItem').mockImplementation((...args) => {
      const turnStatus = accepted && store.getTurnById(accepted.turn.id).status;
      const failedResult = args[0] === accepted?.item.id && turnStatus === 'failed';
      const completion =
        projectionFailure && failedResult
          ? Promise.reject(new Error('Controlled result publication loss.'))
          : updateItem(...args);
      itemPublications.push({ itemId: args[0], turnStatus, completion });
      return completion;
    });
    const pending = submit();
    try {
      await executor.launched.promise;
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(202);
      accepted = SubmitConversationResponseSchema.parse(await response.json());
      const turnId = accepted.turn.id;
      const workerScope = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: accepted.turn.threadId,
        turnId,
      };
      const receiptScope = {
        actorId: 'usr_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        workspaceId: workerScope.workspaceId,
      };
      const receipt = structuredClone(
        store.getCommandRequest('conversation.submit', requestId, receiptScope)
      );
      const threadIds = store
        .listThreads(workerScope.workspaceId)
        .map((thread) => thread.id)
        .sort();
      expect(['pending', 'running']).toContain(accepted.turn.status);
      expect(accepted.turn.agentId).toBe(workerSetup.manifest.id);
      expect(store.getThread(workerScope.workspaceId, workerScope.threadId).parentThreadId).toBe(
        receiptScope.threadId
      );
      const reference = expectedArtifactReferenceItem({ artifact, requestId, turnId });
      expect(accepted.turn.items).toContainEqual(expect.objectContaining(reference));
      expect(JSON.parse(executor.inputs[0]!)).toMatchObject({
        objective: 'Keep this Task Worker running.',
        contextRefs: expect.arrayContaining([
          { kind: 'artifact', id: artifact.id, artifactVersion: artifact.version },
        ]),
      });
      expect(executor.nativeLineage).toMatchObject(workerScope);
      native.peerFaults.failedFinal = true;
      native.peerFaults.failFileExport = true;
      executor.completion.resolve();
      await expect(executor.execution).rejects.toBeDefined();
      await Promise.allSettled(workerLoops);
      const nativeFinal = getWorkerControlAcceptedFinalStatus(coreDb, executor.nativeLineage!);
      const current = store.getTurnById(turnId);
      const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, workerScope);
      const workspaceDb = openWorkspaceDb(dataRoot, workerScope.workspaceId);
      let checkpoint: ReturnType<typeof getWorkerCheckpoint>;
      try {
        checkpoint = getWorkerCheckpoint(
          workspaceDb,
          workerScope.workspaceId,
          workerScope.threadId,
          turnId
        );
      } finally {
        workspaceDb.sqlite.close();
      }
      expect(nativeFinal).toMatchObject({ status: 'failed', stopReason: 'error' });
      expect(native.peerFaults.failedExportPaths.length).toBeGreaterThan(0);
      // A failed native final is transport evidence; the real Core owner must publish failure.
      expect(current.status).toBe('failed');
      expect(current.items).toContainEqual(expect.objectContaining(reference));
      expect(store.getTurnEvents(turnId)).toContainEqual(
        expect.objectContaining({
          event: 'turn.completed',
          data: expect.objectContaining({ type: 'turn-completed', stopReason: 'error' }),
        })
      );
      expect(checkpoint).toMatchObject({
        requestId,
        workerSessionId: executor.nativeLineage!.agentSessionId,
      });
      expect(attempts).toEqual([expect.objectContaining({ phase: 'closing' })]);
      expect(executor.releaseResults).not.toContainEqual(
        expect.objectContaining({ state: 'released' })
      );
      await vi.waitFor(() =>
        expect(
          itemPublications.some(
            (publication) =>
              publication.itemId === accepted!.item.id && publication.turnStatus === 'failed'
          )
        ).toBe(true)
      );
      const publication = itemPublications.find(
        (entry) => entry.itemId === accepted!.item.id && entry.turnStatus === 'failed'
      )!;
      const acknowledged = await publication.completion.then(
        () => true,
        () => false
      );
      expect(acknowledged).toBe(!projectionFailure);
      if (projectionFailure)
        expect(
          store.getTurnById(turnId).items.find((item) => item.id === accepted!.item.id)
        ).toEqual(accepted.item);
      const read = await app.request(...operationRequest('turn.read', workerScope));
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ id: turnId, status: 'failed' });
      const replay = await submit();
      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(store.getCommandRequest('conversation.submit', requestId, receiptScope)).toEqual(
        receipt
      );
      expect(store.listThreadTurns(workerScope.workspaceId, current.threadId)).toHaveLength(1);
      expect(
        store
          .listThreads(workerScope.workspaceId)
          .map((thread) => thread.id)
          .sort()
      ).toEqual(threadIds);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: workerScope.workspaceId,
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(1);
      expect(
        store.listCommandRequests().filter((entry) => entry.command === 'task.start')
      ).toHaveLength(0);
      expect(executor.launches).toBe(1);
    } finally {
      executor.completion.resolve();
      await pending.catch(() => undefined);
      try {
        await Promise.allSettled([
          ...(executor.launches ? [executor.execution] : []),
          ...workerLoops,
        ]);
        await Promise.allSettled(itemPublications.map((publication) => publication.completion));
      } finally {
        publicationObservation.mockRestore();
        if (loopOwners.runWorkerTurnLoop === loopObservation) loopObservation.mockRestore();
        await shutdownControlStoreWorkerClient();
        await native.restore();
        coreDb.sqlite.close();
        rmSync(dataRoot, { force: true, recursive: true });
      }
    }
  });
});

// Simulated continuity still resolves against explicit fixture-owned confirmed image evidence.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

describe('mode command failure diagnostics', () => {
  it.each([
    'conversation',
    'task',
  ] as const)('returns missing image admission through the real %s route before Worker launch', async (mode) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mode-image-admission-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const setup = createTestAgentSetup({ imageRef: `sha256:${'d'.repeat(64)}` });
    const executor = new CompletingTurnExecutor({ coreDb });
    const app = createApp({
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot,
        initialSnapshot: createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [setup.manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Test provider',
              kind: 'local',
              defaultModel: 'openai/gpt-5.2',
              models: ['openai/gpt-5.2'],
            },
          ]),
          openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
          workspaceConfigs: [
            {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              path: join(
                dataRoot,
                'workspaces/ws_00000000-0000-7000-8000-000000000001/config/workspace.jsonc'
              ),
              config: {
                schemaVersion: 1,
                workspace: { name: 'Demo Workspace', defaultAgentId: setup.manifest.id },
              },
            },
          ],
        }),
      }),
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const thread =
      mode === 'conversation'
        ? store.getThread(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
        : await store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Task admission');
    // The generic App fixture admits synthetic defaults; retain acquisition but remove admission.
    coreDb.sqlite
      .prepare('UPDATE worker_image_settlements SET native_environment_json = NULL')
      .run();
    // Bypass this module's automatic admission wrapper at the actual scheduler preview seam.
    const actual = await vi.importActual<typeof import('./runtime/agent-environment.js')>(
      './runtime/agent-environment.js'
    );
    vi.spyOn(executor, 'prepareAgentSessionForTurn').mockImplementation(async (_store, input) => {
      actual.resolveAgentSessionCompatibilityKey({
        ...input,
        agentSessionId: input.freshAgentSessionId,
        triggerActor: input.turn.triggerActor,
        coreDb,
        backend: { kind: 'openshell' },
      });
      throw new Error('Missing image admission unexpectedly succeeded.');
    });
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const requestId = '0190f4c8-0000-7000-8000-000000000951';
      const response = await app.request(
        ...operationRequest(
          mode === 'conversation' ? 'conversation.submit' : 'task.start',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: thread.id },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body:
              mode === 'conversation'
                ? conversationBody({
                    input: 'Implement a bounded README correction.',
                    requestId,
                    targetRef: `warm-worker:${setup.manifest.id}:default`,
                  })
                : JSON.stringify({ input: 'Implement a bounded README correction.', requestId }),
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = await response.json();
      const acceptedTurnId = accepted.turn.id;
      await vi.waitFor(() => expect(store.getTurnById(acceptedTurnId).status).toBe('failed'));
      await vi.waitFor(() =>
        expect(
          observeExecutionAttempts(coreDb).find((attempt) => attempt.turn_id === acceptedTurnId)
            ?.phase
        ).toBe('closed')
      );
      expect(store.getTurnById(acceptedTurnId).error).toMatchObject({
        code: 'worker_preparation_failed',
        message: `Agent "${setup.manifest.id}" requires Worker environment preparation and activation before starting work; verified image defaults are unavailable.`,
      });
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.turn_id === acceptedTurnId)
      ).toMatchObject({ disposition: 'not_accepted', operation_id: null });
      expect(executor.startContexts).toEqual([]);
      await vi.waitFor(() =>
        expect(diagnostics).toHaveBeenCalledWith(
          'scheduler_dispatch_failed_after_admission',
          expect.any(String)
        )
      );
    } finally {
      if (console.error === diagnostics) diagnostics.mockRestore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'conversation',
    'task',
  ] as const)('logs a redacted unexpected %s command error at the existing console sink', async (mode) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mode-unexpected-error-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const app = createApp({ coreDb, dataRoot, store });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const thread =
      mode === 'conversation'
        ? store.getThread(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
        : await store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Task diagnostics');
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Fail inside command execution, after request authorization has read the Workspace.
    vi.spyOn(store, 'getCommandRequest').mockImplementation(() => {
      throw new Error('Unexpected command defect; token=synthetic-canary');
    });
    try {
      const requestId = '0190f4c8-0000-7000-8000-000000000952';
      const response = await app.request(
        ...operationRequest(
          mode === 'conversation' ? 'conversation.submit' : 'task.start',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: thread.id },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body:
              mode === 'conversation'
                ? conversationBody({
                    input: 'Hello',
                    requestId,
                    targetRef: 'internal-role:assistant',
                  })
                : JSON.stringify({ input: 'Implement a bounded README correction.', requestId }),
          }
        )
      );
      expect(await response.json()).toMatchObject({
        code: mode === 'conversation' ? 'chat_mode_failed' : 'task_mode_start_failed',
      });
      expect(diagnostics.mock.calls).toEqual([
        [
          mode === 'conversation' ? 'chat_mode_failed' : 'task_mode_start_failed',
          'Unexpected command defect; token=[redacted]',
        ],
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('Task durable admission response', () => {
  it('refuses a denied Task capability before worker or scheduler effects', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-denied-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const executor = new CompletingTurnExecutor({ coreDb });
    const setup = createTestAgentSetup();
    const app = createApp({
      mode: 'server',
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    try {
      const response = await app.request(
        ...operationRequest(
          'task.start',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token.secret}`,
            },
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000605',
              input:
                'Read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title.',
            }),
          }
        )
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
      expect(executor.startContexts).toHaveLength(0);
      expect(
        store.listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
      ).toHaveLength(0);
      expect(store.listCommandRequests()).toHaveLength(0);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(0);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  // The held completion proves admission ordering; this budget covers real fixture setup.
  it.each([
    ...(['direct', 'assistant', 'remote-mcp', 'closeout-failure'] as const).map((entry) => ({
      entry,
      input: 'Implement a focused change and run its tests.',
    })),
    {
      entry: 'direct',
      input:
        'Read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title.',
    },
    {
      entry: 'direct',
      input:
        'Please read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title.',
    },
    {
      entry: 'direct',
      input:
        'Could you read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title?',
    },
    { entry: 'direct', input: 'Fetch issue 110 of lingkaix/openkit and return its title.' },
    { entry: 'direct', input: 'Retrieve issue 110 of lingkaix/openkit and return its title.' },
    { entry: 'direct', input: 'Get issue 110 of lingkaix/openkit and reply with its title.' },
    { entry: 'direct', input: 'Look up issue 110 of lingkaix/openkit and reply with its title.' },
    {
      entry: 'direct',
      input: 'Using the github MCP tools, report the title of issue 110 of lingkaix/openkit.',
    },
    {
      entry: 'direct',
      input: 'Issue 110 of lingkaix/openkit: reply with its title using the github MCP tools.',
    },
    {
      entry: 'direct',
      input: 'Find the title of issue 110 of lingkaix/openkit using the github MCP tools.',
    },
    { entry: 'direct', input: 'Help.' },
    { entry: 'direct', input: 'What is OpenKit?' },
    { entry: 'direct', input: 'Plan a multi-step release goal for NanoCore.' },
    {
      entry: 'direct',
      input:
        '  Read issue 110 of lingkaix/openkit. Do not deploy to production.\nReply with its title.  ',
    },
  ])('returns $entry admission for "$input" before the held worker finishes', async ({
    entry,
    input,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-admission-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const native = createNativeTaskAdmissionFixture(coreDb, store);
    const executor = native.executor;
    executor.failCloseout = entry === 'closeout-failure';
    const setup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const provider = taskProposalProvider(input, setup.manifest.id);
    const app = createAppWithWorkspaceAuthority({
      fileAdmission: native.fileAdmission,
      workerControlGateway: native.workerControlGateway,
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
      ...(entry === 'assistant' ? { llmPiAiClient: provider.client } : {}),
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const requestId = '0190f4c8-0000-7000-8000-000000000601';
    const command = entry === 'assistant' ? 'conversation.submit' : 'task.start';
    const scope = {
      actorId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
    };
    const token =
      entry === 'remote-mcp'
        ? createOpenKitAccessTokenRecord(coreDb, {
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            scope: 'workspace',
            workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
            expiresAt: '2099-01-01T00:00:00.000Z',
          })
        : null;
    /** Calls the real JSON or remote MCP binding with the same immutable request identity. */
    const submit = (text = input) => {
      const body =
        command === 'conversation.submit'
          ? { input: text, requestId, targetRef: 'internal-role:assistant', artifactRefs: [] }
          : { input: text, requestId };
      if (token)
        return app.request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token.secret}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'openkit_call',
              arguments: {
                operation: 'task.start',
                input: {
                  ...body,
                  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                  threadId: 'th_00000000-0000-7000-8000-000000000001',
                },
              },
            },
          }),
        });
      return app.request(
        ...operationRequest(
          command,
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
      );
    };
    const deletedCheckpointTurns: string[] = [];
    const loopSettled = Promise.withResolvers<void>();
    const originalLoop = loopOwners.runWorkerTurnLoop;
    const loopObservation = vi
      .spyOn(loopOwners, 'runWorkerTurnLoop')
      .mockImplementation((args) => originalLoop(args).finally(loopSettled.resolve));
    const collected = Promise.withResolvers<void>();
    void collected.promise.catch(() => undefined);
    const originalCollection = recoveryOwners.clearWorkerCheckpointAfterTerminalState;
    const collectionObservation = vi
      .spyOn(recoveryOwners, 'clearWorkerCheckpointAfterTerminalState')
      .mockImplementation((...args) =>
        originalCollection(...args).then(
          (result) => {
            if (result) deletedCheckpointTurns.push(args[1].turnId);
            collected.resolve();
            return result;
          },
          (error) => {
            collected.reject(error);
            throw error;
          }
        )
      );
    const publicationEvents: string[] = [];
    const writer = getControlStoreWorkerClient();
    const transition = writer.transition.bind(writer);
    const terminal = writer.terminal.bind(writer);
    // The real native method resolves only after its outer FULL COMMIT acknowledgement.
    const receiptPublication = vi
      .spyOn(writer, 'transition')
      .mockImplementation(async (...args) => {
        const result = await transition(...args);
        const receipt = args[1].receipt;
        if (receipt.command === command && receipt.requestId === requestId)
          publicationEvents.push('publication');
        return result;
      });
    const terminalPublication = vi.spyOn(writer, 'terminal').mockImplementation(async (...args) => {
      const result = await terminal(...args);
      const receipt = args[1].command?.receipt;
      if (receipt?.command === command && receipt.requestId === requestId)
        publicationEvents.push('publication');
      return result;
    });
    let receiptAtResponse: undefined | ReturnType<FsStore['getCommandRequest']>;
    let responseObserved = false;
    // Attach the first observation immediately; no await may precede this receipt read.
    const pending = Promise.resolve(submit()).then((response) => {
      receiptAtResponse = store.getCommandRequest(command, requestId, scope);
      publicationEvents.push('response');
      responseObserved = true;
      return response;
    });
    let turnId: string | undefined;
    let dispatch = Promise.resolve<unknown>(undefined);
    let proposingTurn: ReturnType<FsStore['getTurnById']> | undefined;
    let requestItemId: string | undefined;
    let answerRequest: ReturnType<typeof confirmTaskRequest> | undefined;
    let answerResult: unknown;
    let answerReceipt: ReturnType<FsStore['getCommandRequest']> | undefined;
    try {
      // Await the response under the test timeout; the held executor proves publication ordering.
      const response = await pending;
      let completionObserved = false;
      void executor.finished.promise.then(() => {
        completionObserved = true;
      });
      await setImmediate();
      // Ordered events are the oracle: the executor is still waiting on test-owned release.
      expect(responseObserved).toBe(true);
      expect(receiptAtResponse).toMatchObject({ command, requestId });
      expect(publicationEvents).toEqual(['publication', 'response']);
      expect(completionObserved).toBe(false);
      expect(response.status, await response.clone().text()).toBe(token ? 200 : 202);
      const wire = await response.json();
      const result = token ? JSON.parse(wire.result.content[0].text) : wire;
      if (entry === 'assistant') {
        const accepted = SubmitConversationResponseSchema.parse(result);
        expect(accepted.outcome).toBe('clarification-needed');
        expect(accepted.turn.status).toBe('completed');
        expect(accepted.item).toMatchObject({
          type: 'user-input-request',
          assistantHandoff: {
            kind: 'task',
            targetWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            input,
            agentId: setup.manifest.id,
          },
        });
        expect(executor.launches).toBe(0);
        expect(
          listSchedulerAdmissionEntriesForWorkspace(coreDb, {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
          })
        ).toEqual([]);
        if (accepted.item.type !== 'user-input-request') throw new Error('Expected confirmation.');
        // Chat Handoff rules: the later outcome leaves its terminal proposing Turn unchanged.
        proposingTurn = structuredClone(store.getTurnById(accepted.turn.id));
        expect(proposingTurn.status).toBe('completed');
        requestItemId = accepted.item.id;
        answerRequest = confirmTaskRequest(accepted.item, '0190f4c8-0000-7000-8000-000000000611');
        const answer = await app.request(...answerRequest);
        expect(answer.status, await answer.clone().text()).toBe(200);
        answerResult = await answer.json();
        answerReceipt = structuredClone(
          store.listCommandRequests().find((record) => record.command === 'user_input.answer')
        );
        expect(answerReceipt).toBeDefined();
        await vi.waitFor(() =>
          expect(
            listSchedulerAdmissionEntriesForWorkspace(coreDb, {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              statuses: ['queued', 'admitted'],
            })
          ).toHaveLength(1)
        );
        turnId = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          statuses: ['queued', 'admitted'],
        })[0]!.turnId;
        expect(provider.createResponses).toHaveBeenCalledTimes(2);
      } else {
        turnId = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })[0]!.turnId;
        const accepted = StartTaskModeResponseSchema.parse(result);
        expect(['queued', 'running']).toContain(accepted.state);
        expect(accepted.turn.id).toBe(turnId);
        expect(['pending', 'running']).toContain(accepted.turn.status);
        expect(accepted.completion ?? null).toBeNull();
        expect(accepted.evidence).toEqual({ itemIds: [], artifactIds: [], reviewIds: [] });
      }
      if (entry === 'assistant')
        await vi.waitFor(() =>
          expect(store.listThreadItems(scope.workspaceId, scope.threadId)).toContainEqual(
            expect.objectContaining({ causationId: turnId, status: 'completed' })
          )
        );
      const workerThreadId = store.getTurnById(turnId).threadId;
      const receipt = receiptAtResponse!;
      expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
      expect(receipt).toMatchObject({ command, requestId, response: { kind: 'turn' } });
      if (entry === 'assistant') {
        expect(receipt.response.conversationMetadata).toMatchObject({
          resultKind: 'clarification',
          downstream: null,
        });
        expect(store.listCommandRequests().filter((r) => r.command === 'task.start')).toHaveLength(
          0
        );
      } else expect(receipt.response.id).toBe(turnId);
      const replay = await submit();
      expect(replay.status, await replay.clone().text()).toBe(token ? 200 : 202);
      const replayWire = await replay.json();
      const replayResult = token ? JSON.parse(replayWire.result.content[0].text) : replayWire;
      if (entry === 'assistant') {
        expect(SubmitConversationResponseSchema.parse(replayResult)).toEqual(result);
        expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
      } else expect(StartTaskModeResponseSchema.parse(replayResult).turn.id).toBe(turnId);
      // Check launch only after the durable receipt and exact current-owner replay.
      if (entry === 'assistant') {
        dispatch = runSchedulerDispatchLoop({
          coreDb,
          store,
          turnExecutor: executor,
          executionBackend: executor.executionBackend,
          agentManifests: [setup.manifest],
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Fixture',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
          gatewayConfig: createTestGatewayConfig(),
          maxDispatches: 1,
        });
        void dispatch.catch(() => undefined);
      }
      await vi.waitFor(() => expect(executor.launches).toBe(1));
      await executor.launched.promise;
      const currentAttempt = observeExecutionAttempts(coreDb).find(
        (attempt) =>
          attempt.turn_id ===
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: store.getTurnById(turnId!).threadId,
            turnId,
          }.turnId
      );
      expect(
        currentAttempt,
        'The launched Turn must have its exact durable attempt.'
      ).toBeDefined();
      expect(executor.checkpointAtLaunch).toMatchObject({
        stage: 'running_worker',
        workerSessionId: currentAttempt!.agent_session_id,
        stopReason: null,
      });
      const conflict = await submit('Implement a different change.');
      if (!token) {
        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });
      } else {
        expect(conflict.status).toBe(200);
        const refused = (await conflict.json()).result;
        expect(refused.isError).toBe(true);
        expect(JSON.parse(refused.content[0].text)).toMatchObject({
          code: 'idempotency_key_conflict',
        });
      }
      expect(executor.launches).toBe(1);
      expect(JSON.parse(executor.inputs[0]!).objective).toBe(input);
      expect(JSON.parse(executor.inputs[0]!).constraints.maxWorkerIterations).toBe(1);
      expect(store.listCommandRequests().some((record) => record.command === 'goal.create')).toBe(
        false
      );
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(1);
      // Native launch requires the exact immutable initiating Item before Session/checkpoint binding.
      const initiatingItemId = deriveEntityId('it', ['task-user', turnId]);
      const initiatingItems = store
        .getTurnById(turnId)
        .items.filter((i) => i.type === 'user-message');
      expect(initiatingItems).toEqual([
        expect.objectContaining({
          id: initiatingItemId,
          actor: store.getTurnById(turnId).triggerActor,
          text: executor.inputs[0],
          status: 'completed',
        }),
      ]);
      if (entry === 'direct') {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        const checkpoint = getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          store.getTurnById(turnId).threadId,
          turnId
        )!;
        try {
          for (const [column, original] of [
            ['request_input_hash', checkpoint.requestInputHash],
            ['context_digest', checkpoint.contextDigest],
          ] as const) {
            await mutateQuiescentCheckpoint(() =>
              workspaceDb.sqlite
                .prepare(`UPDATE worker_turn_checkpoints SET ${column} = ? WHERE checkpoint_id = ?`)
                .run('sha256:contradiction', checkpoint.checkpointId)
            );
            try {
              const refused = await submit();
              expect(refused.status).toBe(409);
              await expect(refused.json()).resolves.toMatchObject({ code: 'recovery_required' });
            } finally {
              await mutateQuiescentCheckpoint(() =>
                workspaceDb.sqlite
                  .prepare(
                    `UPDATE worker_turn_checkpoints SET ${column} = ? WHERE checkpoint_id = ?`
                  )
                  .run(original, checkpoint.checkpointId)
              );
            }
          }
        } finally {
          workspaceDb.sqlite.close();
        }
        expect((await submit()).status).toBe(202);
        expect(executor.launches).toBe(1);
      }
      executor.completion.resolve();
      await executor.finished.promise;
      if (entry === 'closeout-failure')
        await expect(executor.execution).rejects.toThrow('Controlled release response loss.');
      else await executor.execution;
      await dispatch;
      await vi.waitFor(() =>
        expect(
          observeExecutionAttempts(coreDb).find((attempt) => attempt.turn_id === turnId)?.phase
        ).toBe(entry === 'closeout-failure' ? 'closing' : 'closed')
      );
      await setImmediate();
      const turnRead = await app.request(
        ...operationRequest(
          'turn.read',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: workerThreadId,
            turnId,
          },
          { method: 'GET' }
        )
      );
      expect(turnRead.status).toBe(200);
      expect(await turnRead.json()).toMatchObject({ id: turnId, status: 'completed' });
      const itemsRead = await app.request(
        ...operationRequest(
          'thread.items',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: workerThreadId },
          { method: 'GET' }
        )
      );
      expect(itemsRead.status).toBe(200);
      expect((await itemsRead.json()).items).toContainEqual(
        expect.objectContaining({
          id: deriveEntityId('it', ['worker', turnId, 1]),
          type: 'assistant-message',
          status: 'completed',
          text: executor.inputs[0],
        })
      );
      const terminalItems = store.getTurnById(turnId).items;
      expect(terminalItems.filter((item) => item.type === 'assistant-message')).toHaveLength(1);
      expect(terminalItems.filter((item) => item.type === 'user-message')).toEqual(initiatingItems);
      await assertNativeTaskAdmission(coreDb, store, turnId, entry === 'closeout-failure');
      expect(executor.releaseResults).toEqual([
        expect.objectContaining({
          state: 'released',
          fenceRef: expect.any(String),
          attemptId: currentAttempt!.attempt_id,
        }),
      ]);
      await loopSettled.promise;
      if (entry !== 'closeout-failure') await collected.promise;
      const terminalReplay = await submit();
      if (entry === 'closeout-failure') {
        expect(terminalReplay.status).toBe(409);
        await expect(terminalReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
      } else {
        expect(terminalReplay.status).toBe(token ? 200 : 202);
        const terminalWire = await terminalReplay.json();
        if (entry === 'assistant') {
          expect(SubmitConversationResponseSchema.parse(terminalWire)).toEqual(result);
        } else {
          const terminal = StartTaskModeResponseSchema.parse(
            token ? JSON.parse(terminalWire.result.content[0].text) : terminalWire
          );
          expect(terminal).toMatchObject({
            state: 'completed',
            turn: { id: turnId },
            completion: { itemId: deriveEntityId('it', ['worker', turnId, 1]) },
          });
        }
      }
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        const checkpoint = getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          workerThreadId,
          turnId
        );
        if (entry === 'closeout-failure') expect(checkpoint?.stage).toBe('completed');
        else expect(checkpoint).toBeNull();
      } finally {
        workspaceDb.sqlite.close();
      }
      expect(
        deletedCheckpointTurns.filter((clearedTurnId) => clearedTurnId === turnId)
      ).toHaveLength(entry === 'closeout-failure' ? 0 : 1);
      const closedAttempt = observeExecutionAttempts(coreDb).filter(
        (attempt) =>
          attempt.turn_id ===
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: store.getTurnById(turnId).threadId,
            turnId,
          }.turnId
      )[0]!;
      const repeatedReplay = await submit();
      expect(repeatedReplay.status).toBe(entry === 'closeout-failure' ? 409 : token ? 200 : 202);
      expect(
        observeExecutionAttempts(coreDb).filter(
          (attempt) =>
            attempt.turn_id ===
            {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              turnId,
            }.turnId
        )[0]
      ).toEqual(closedAttempt);
      expect(
        store.getTurnEvents(turnId).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);

      expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
      expect(store.getTurnById(turnId).items).toEqual(terminalItems);
      expect(executor.launches).toBe(1);
      if (entry === 'assistant') {
        // Pending Resolve: exact replay preserves the recorded answer without another effect.
        const answerReplay = await app.request(...answerRequest!);
        expect(answerReplay.status, await answerReplay.clone().text()).toBe(200);
        expect(await answerReplay.json()).toEqual(answerResult);
        expect(
          store.listCommandRequests().filter((record) => record.command === 'user_input.answer')
        ).toEqual([answerReceipt]);
        expect(store.getCommandRequest(command, requestId, scope)).toEqual(receipt);
        expect(store.getTurnById(proposingTurn!.id)).toEqual(proposingTurn);
        const receivingTurn = store.getTurnById(turnId);
        expect(receivingTurn).toMatchObject({
          agentId: setup.manifest.id,
          triggerSource: { kind: 'handoff' },
        });
        expect(workerThreadId).not.toBe(scope.threadId);
        expect(store.getThread(scope.workspaceId, workerThreadId)).toMatchObject({
          visibility: 'workspace',
          parentThreadId: scope.threadId,
        });
        const handoff = store
          .listThreadItems(scope.workspaceId, scope.threadId)
          .find((item) => item.type === 'status' && item.causationId === turnId);
        expect(handoff).toMatchObject({ status: 'completed', threadId: scope.threadId });
        expect(handoff!.turnId).not.toBe(proposingTurn!.id);
        const outcomeTurn = store.getTurnById(handoff!.turnId);
        expect(outcomeTurn).toMatchObject({
          threadId: scope.threadId,
          status: 'completed',
          triggerSource: { kind: 'user-input' },
        });
        const sourceDb = openWorkspaceDb(dataRoot, scope.workspaceId);
        try {
          expect(
            listThreadPendingRequests(sourceDb.sqlite, scope.workspaceId, scope.threadId)
          ).toContainEqual(
            expect.objectContaining({
              raisingTurnId: proposingTurn!.id,
              requestItemId,
              requesterKind: 'assistant',
              resolution: 'answered',
              delivery: 'delivered',
              deliveryCause: 'outcome',
              deliveryTurnId: outcomeTurn.id,
              assistantHandoff: {
                kind: 'task',
                targetWorkspaceId: scope.workspaceId,
                input,
                agentId: setup.manifest.id,
              },
            })
          );
        } finally {
          sourceDb.sqlite.close();
        }
        expect(executor.launches).toBe(1);
        expect(provider.createResponses).toHaveBeenCalledTimes(2);
        expect(store.listCommandRequests().filter((r) => r.command === 'task.start')).toHaveLength(
          0
        );
        expect(
          store.listCommandRequests().filter((r) => r.command === 'conversation.submit')
        ).toHaveLength(1);
      }
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(1);
    } finally {
      executor.completion.resolve();
      await pending.catch(() => undefined);
      await dispatch.catch(() => undefined);
      if (executor.launches > 0) {
        await executor.finished.promise;
        const succeeded = await executor.execution.then(
          () => true,
          () => false
        );
        await loopSettled.promise;
        if (succeeded) await collected.promise.catch(() => undefined);
      }
      await setImmediate();
      receiptPublication.mockRestore();
      terminalPublication.mockRestore();
      if (loopOwners.runWorkerTurnLoop === loopObservation) loopObservation.mockRestore();
      if (recoveryOwners.clearWorkerCheckpointAfterTerminalState === collectionObservation)
        collectionObservation.mockRestore();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  }, 60_000);
});

describe('exact Task Agent selection', () => {
  /** Creates real operation, Coordinator, scheduler and replay owners, with capacity held before execution. */
  async function fixture() {
    const dataRoot = mkdtempSync(join(tmpdir(), 'exact-task-agent-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const executor = new HoldingTurnExecutor(coreDb);
    const preferred = createTestAgentSetup({ agentId: 'agent_preferred' }).manifest;
    const selected = createTestAgentSetup({ agentId: 'agent_selected' }).manifest;
    const makeApp = (ownerStore = store, manifests = [preferred, selected]) =>
      createAppWithWorkspaceAuthority({
        coreDb,
        dataRoot,
        store: ownerStore,
        turnExecutor: executor,
        agentManifests: manifests,
        openKitConfig: { defaults: { defaultAgentId: preferred.id } },
      });
    const app = makeApp();
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const prepare = vi
      .spyOn(executor, 'prepareAgentSessionForTurn')
      .mockRejectedValue(new WorkerGovernanceCapacityUnavailableError());
    const requestId = '0190f4c8-0000-7000-8000-000000000133';
    const scope = {
      actorId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
    };
    const post = (target: typeof app, choice: { agentId?: string; modelId?: string } = {}) =>
      target.request(
        ...operationRequest(
          'task.start',
          { workspaceId: scope.workspaceId, threadId: scope.threadId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, input: 'Implement a focused change.', ...choice }),
          }
        )
      );
    /** Observes the existing effect owners, rather than inferring no effect from a refusal response. */
    const effects = () => {
      const db = openWorkspaceDb(dataRoot, scope.workspaceId);
      try {
        return {
          turns: store.listThreadTurns(scope.workspaceId, scope.threadId),
          items: store.listThreadItems(scope.workspaceId, scope.threadId),
          receipts: store.listCommandRequests(),
          admissions: listSchedulerAdmissionEntriesForWorkspace(coreDb, {
            workspaceId: scope.workspaceId,
            statuses: ['queued', 'admitted', 'cancelled', 'denied', 'expired'],
          }),
          attempts: observeExecutionAttempts(coreDb),
          checkpoints: db.sqlite.prepare('SELECT * FROM worker_turn_checkpoints').all(),
        };
      } finally {
        db.sqlite.close();
      }
    };
    /** Lets the capacity refusal finish before a stable observation or fixture disposal. */
    const settlePreparation = async () => {
      await setImmediate();
      await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
    };
    return {
      app,
      coreDb,
      dataRoot,
      effects,
      executor,
      makeApp,
      post,
      preferred,
      prepare,
      requestId,
      scope,
      selected,
      settlePreparation,
      store,
      /** Releases only this fixture after its background preparation has settled. */
      async cleanup() {
        await settlePreparation();
        prepare.mockRestore();
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
        rmSync(dataRoot, { recursive: true, force: true });
      },
    };
  }

  it.each([
    'omitted',
    'supplied',
  ] as const)('keeps %s selection and replay identity through duplicate admission and changed readiness', async (selector) => {
    const f = await fixture();
    const choice = selector === 'supplied' ? { agentId: f.selected.id } : {};
    const expectedAgentId = selector === 'supplied' ? f.selected.id : f.preferred.id;
    // Fixed canonical bytes make adding a null/default selector observable for old commands.
    const canonicalInput =
      selector === 'supplied'
        ? '{"agentId":"agent_selected","input":"Implement a focused change."}'
        : '{"input":"Implement a focused change."}';
    const expectedHash = `sha256:${createHash('sha256').update(canonicalInput).digest('hex')}`;
    try {
      const responses = await Promise.all([f.post(f.app, choice), f.post(f.app, choice)]);
      const turns = [];
      for (const response of responses) {
        expect(response.status, await response.clone().text()).toBe(202);
        turns.push(StartTaskModeResponseSchema.parse(await response.json()).turn);
      }
      const turn = turns[0]!;
      expect(turn).toMatchObject({ agentId: expectedAgentId, status: 'pending' });
      expect(turns[1]).toEqual(turn);
      expect(
        f.store.listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
      ).toHaveLength(1);
      expect(f.store.getCommandRequest('task.start', f.requestId, f.scope)).toMatchObject({
        inputHash: expectedHash,
        response: { kind: 'turn', id: turn.id },
      });
      const db = openWorkspaceDb(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        expect(
          getWorkerCheckpoint(
            db,
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001',
            turn.id
          )
        ).toMatchObject({
          requestInputHash: expectedHash,
        });
      } finally {
        db.sqlite.close();
      }
      await f.settlePreparation();
      const beforeReplay = f.effects();
      expect(beforeReplay.admissions).toHaveLength(1);
      expect(f.executor.launches).toBe(0);

      // Reopen the durable store with the original Agent unavailable and a different ready supply.
      const remaining = createTestAgentSetup({ agentId: 'agent_replacement' }).manifest;
      const reloaded = await createDemoStore({ dataRoot: f.dataRoot });
      const restarted = f.makeApp(reloaded, [remaining]);
      const preparationCount = f.prepare.mock.calls.length;
      const replay = await f.post(restarted, choice);
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await replay.json()).turn).toEqual(turn);
      const changedSelectors =
        selector === 'supplied' ? [{}, { agentId: remaining.id }] : [{ agentId: expectedAgentId }];
      for (const changed of changedSelectors) {
        const conflict = await f.post(restarted, changed);
        expect(conflict.status, await conflict.clone().text()).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
      }
      expect(f.effects()).toEqual(beforeReplay);
      expect(f.prepare).toHaveBeenCalledTimes(preparationCount);
      expect(f.executor.launches).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    'missing',
    'blocked',
    'disabled',
    'unknown',
    'degraded',
  ] as const)('refuses a %s exact Agent before effects without using the ready preferred Agent', async (readiness) => {
    const f = await fixture();
    try {
      const selected = {
        ...f.selected,
        readiness: { status: readiness === 'missing' ? ('ready' as const) : readiness },
      };
      const app = f.makeApp(
        f.store,
        readiness === 'missing' ? [f.preferred] : [f.preferred, selected]
      );
      const before = f.effects();
      const response = await f.post(app, { agentId: f.selected.id });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'task_mode_not_delegated' });
      expect(f.effects()).toEqual(before);
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.executor.launches).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it('preserves the typed model refusal for an exactly selected Agent', async () => {
    const f = await fixture();
    try {
      const before = f.effects();
      const response = await f.post(f.app, {
        agentId: f.selected.id,
        modelId: 'other-model',
      });
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'model_not_supported_by_agent' });
      expect(
        f.store.listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
      ).toEqual(before.turns);
      expect(f.effects().admissions).toEqual(before.admissions);
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.executor.launches).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it('admits an exact Agent with an unavailable preferred model when an allowed healthy model is requested', async () => {
    const f = await fixture();
    const healthyModelId = 'openai/gpt-5.2';
    try {
      const selected = {
        ...f.selected,
        models: {
          preferredLogicalModelId: 'unavailable-preferred-model',
          allowedLogicalModelIds: 'all' as const,
        },
      };
      const gateway = createTestGatewayConfig();
      const app = createAppWithWorkspaceAuthority({
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
        turnExecutor: f.executor,
        agentManifests: [f.preferred, selected],
        openKitConfig: { defaults: { defaultAgentId: f.preferred.id } },
        gatewayConfig: {
          ...gateway,
          logicalModels: [
            ...gateway.logicalModels,
            {
              ...gateway.logicalModels[0]!,
              id: selected.models.preferredLogicalModelId,
              routes: [
                {
                  id: 'unavailable-route',
                  providerProfileId: 'unavailable-provider',
                  providerModel: healthyModelId,
                },
              ],
            },
          ],
        },
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Healthy local Provider',
            kind: 'local',
            models: [healthyModelId],
          },
          {
            id: 'unavailable-provider',
            displayName: 'Missing-key Provider',
            kind: 'llm-gateway',
            vendor: 'openai',
            baseUrl: 'https://inference.example.invalid/v1',
            models: [healthyModelId],
            secretRef: 'vault://vault_00000000-0000-7256-b454-e714d6ce8135',
          },
        ]),
        providerCredentialResolver: () => null,
      });
      const response = await f.post(app, { agentId: selected.id, modelId: healthyModelId });
      expect(response.status, await response.clone().text()).toBe(202);
      const { turn } = StartTaskModeResponseSchema.parse(await response.json());
      expect(turn).toMatchObject({ agentId: selected.id, status: 'pending' });
      await f.settlePreparation();
      const effects = f.effects();
      expect(effects.turns).toHaveLength(1);
      expect(effects.receipts).toHaveLength(1);
      expect(effects.checkpoints).toHaveLength(1);
      expect(effects.admissions).toEqual([
        expect.objectContaining({
          turnId: turn.id,
          requestedAgentId: selected.id,
          modelId: healthyModelId,
        }),
      ]);
      expect(f.executor.launches).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it('refuses an unavailable requested model before Knowledge even when the exact Agent preferred model is healthy', async () => {
    const f = await fixture();
    const healthyModelId = 'openai/gpt-5.2';
    const unavailableModelId = 'unavailable-requested-model';
    const knowledge = vi
      .spyOn(knowledgeOwners, 'createTaskKnowledgePreparation')
      .mockRejectedValue(
        new Error('Unexpected Knowledge preparation for an unavailable requested model.')
      );
    try {
      const selected = {
        ...f.selected,
        models: { preferredLogicalModelId: healthyModelId, allowedLogicalModelIds: 'all' as const },
      };
      const gateway = createTestGatewayConfig();
      const app = createAppWithWorkspaceAuthority({
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
        turnExecutor: f.executor,
        agentManifests: [f.preferred, selected],
        openKitConfig: { defaults: { defaultAgentId: f.preferred.id } },
        gatewayConfig: {
          ...gateway,
          logicalModels: [
            ...gateway.logicalModels,
            {
              ...gateway.logicalModels[0]!,
              id: unavailableModelId,
              routes: [
                {
                  id: 'unavailable-route',
                  providerProfileId: 'unavailable-provider',
                  providerModel: healthyModelId,
                },
              ],
            },
          ],
        },
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Healthy local Provider',
            kind: 'local',
            models: [healthyModelId],
          },
          {
            id: 'unavailable-provider',
            displayName: 'Missing-key Provider',
            kind: 'llm-gateway',
            vendor: 'openai',
            baseUrl: 'https://inference.example.invalid/v1',
            models: [healthyModelId],
            secretRef: 'vault://vault_00000000-0000-74f1-9f1c-de471b56860f',
          },
        ]),
        providerCredentialResolver: () => null,
      });
      const before = f.effects();
      const response = await f.post(app, { agentId: selected.id, modelId: unavailableModelId });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(knowledge).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ code: 'task_mode_not_delegated' });
      expect(f.effects()).toEqual(before);
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.executor.launches).toBe(0);
    } finally {
      if (knowledgeOwners.createTaskKnowledgePreparation === knowledge) knowledge.mockRestore();
      await f.cleanup();
    }
  });

  it.each([
    'missing-control-binary',
    'unsupported-resources',
  ] as const)('refuses exact Agent setup with %s before Knowledge or durable effects', async (ineligibility) => {
    const f = await fixture();
    // Knowledge is downstream of eligibility. Fail at its real entry if admission crosses it.
    const knowledge = vi
      .spyOn(knowledgeOwners, 'createTaskKnowledgePreparation')
      .mockRejectedValue(new Error('Unexpected Knowledge preparation for an ineligible Agent.'));
    try {
      const selected =
        ineligibility === 'missing-control-binary'
          ? {
              ...f.selected,
              runtime: {
                ...f.selected.runtime,
                binaries: f.selected.runtime.binaries.filter(
                  (binary) => binary.id !== 'openkit-worker-shim'
                ),
              },
            }
          : { ...f.selected, resources: { 'unenforced-test-resource': { limit: 2 } } };
      const app = f.makeApp(f.store, [f.preferred, selected]);
      const before = f.effects();
      const response = await f.post(app, { agentId: f.selected.id });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(knowledge).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ code: 'task_mode_not_delegated' });
      expect(f.effects()).toEqual(before);
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.executor.launches).toBe(0);
    } finally {
      if (knowledgeOwners.createTaskKnowledgePreparation === knowledge) knowledge.mockRestore();
      await f.cleanup();
    }
  });
});

describe('route B queued Task receipts', () => {
  it.each([
    'direct',
    'selected-conversation',
  ] as const)('acknowledges capacity waiting through %s and replays the original pending Turn after reload', async (entry) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'route-b-queued-receipt-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const executor = new HoldingTurnExecutor(coreDb);
    const setup = createTestAgentSetup();
    const makeApp = (ownerStore: FsStore) =>
      createAppWithWorkspaceAuthority({
        coreDb,
        dataRoot,
        store: ownerStore,
        turnExecutor: executor,
        agentManifests: [setup.manifest],
        openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
      });
    const app = makeApp(store);
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const command = entry === 'direct' ? 'task.start' : 'conversation.submit';
    const requestId = '0190f4c8-0000-7000-8000-000000000999';
    const scope = {
      actorId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
    };
    const post = (
      target: typeof app,
      identity = requestId,
      text = 'Implement a focused change and run its tests.'
    ) =>
      target.request(
        ...operationRequest(
          command,
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: identity,
              input: text,
              ...(entry === 'selected-conversation'
                ? { targetRef: 'new-task-worker', artifactRefs: [] }
                : {}),
            }),
          }
        )
      );
    const prepare = vi
      .spyOn(executor, 'prepareAgentSessionForTurn')
      .mockRejectedValue(new WorkerGovernanceCapacityUnavailableError());
    try {
      const response = await post(app);
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = await response.json();
      const turn = accepted.turn;
      expect(turn).toMatchObject({ status: 'pending' });
      expect(turn.agentSessionId ?? null).toBeNull();
      const queued = listQueuedSchedulerAdmissionEntries(coreDb);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        turnId: turn.id,
        threadId: turn.threadId,
        status: 'queued',
      });
      expect(store.getTurnById(turn.id)).toEqual(turn);
      expect(store.getCommandRequest(command, requestId, scope)).toMatchObject({
        response: { kind: 'turn', id: turn.id },
      });
      expect(executor.launches).toBe(0);
      const reloaded = await createDemoStore({ dataRoot });
      const replay = await post(makeApp(reloaded));
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect((await replay.json()).turn.id).toBe(turn.id);
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual(queued);
      const conflict = await post(makeApp(reloaded), requestId, 'Different immutable input.');
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
      expect(listQueuedSchedulerAdmissionEntries(coreDb)).toEqual(queued);
      expect(executor.launches).toBe(0);
    } finally {
      prepare.mockRestore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { failPreparation: false, entry: 'direct' },
    { failPreparation: true, entry: 'direct', replayBeforeCollection: false },
    { failPreparation: true, entry: 'direct', replayBeforeCollection: true },
    { failPreparation: true, entry: 'selected-conversation' },
    { failPreparation: true, entry: 'direct', proofGap: 'native' },
    { failPreparation: true, entry: 'direct', proofGap: 'input' },
  ] as const)('publishes the receipt while preparation is held through $entry and preserves the original Turn on later failure=$failPreparation replayBeforeCollection=$replayBeforeCollection proofGap=$proofGap', async ({
    failPreparation,
    entry,
    ...scenario
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'route-b-held-preparation-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const executor = new HoldingTurnExecutor(coreDb);
    const setup = createTestAgentSetup();
    const app = createAppWithWorkspaceAuthority({
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalPrepare = executor.prepareAgentSessionForTurn.bind(executor);
    const prepare = vi
      .spyOn(executor, 'prepareAgentSessionForTurn')
      .mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        if (failPreparation)
          throw new Error('Controlled preparation failure before native submission.');
        return originalPrepare(...args);
      });
    const requestId = '0190f4c8-0000-7000-8000-000000000993';
    let observed: Response | undefined;
    const pending = Promise.resolve(
      app.request(
        ...operationRequest(
          entry === 'direct' ? 'task.start' : 'conversation.submit',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId,
              input: 'Implement a focused change and run its tests.',
              ...(entry === 'selected-conversation'
                ? { targetRef: 'new-task-worker', artifactRefs: [] }
                : {}),
            }),
          }
        )
      )
    ).then((response) => {
      observed = response;
      return response;
    });
    try {
      await entered.promise;
      await setImmediate();
      expect(
        observed?.status,
        'Receipt must be delivered before test-owned preparation release.'
      ).toBe(202);
      const accepted = await observed!.json();
      const admittedId = accepted.turn.id;
      expect(
        store.getCommandRequest(
          entry === 'direct' ? 'task.start' : 'conversation.submit',
          requestId,
          {
            actorId: 'usr_00000000-0000-7000-8000-000000000001',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          }
        )
      ).toMatchObject({ response: { kind: 'turn', id: admittedId } });
      expect(executor.launches).toBe(0);
      release.resolve();
      if (failPreparation) {
        await vi.waitFor(() => expect(store.getTurnById(admittedId).status).toBe('failed'));
        expect(executor.launches).toBe(0);
        expect(
          listSchedulerAdmissionEntriesForWorkspace(coreDb, {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            statuses: ['queued', 'admitted', 'cancelled', 'denied'],
          }).map((row) => row.turnId)
        ).toEqual([admittedId]);
        await vi.waitFor(() =>
          expect(
            observeExecutionAttempts(coreDb).find((a) => a.turn_id === admittedId)
          ).toMatchObject({
            phase: 'closed',
            disposition: 'not_accepted',
            agent_session_id: null,
            input_ref: null,
            binding_ref: null,
            operation_id: null,
            outcome_ref: null,
            fence_ref: null,
          })
        );
        const checkpointDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
        try {
          if (entry === 'selected-conversation') {
            await vi.waitFor(() =>
              expect(
                getWorkerCheckpoint(
                  checkpointDb,
                  'ws_00000000-0000-7000-8000-000000000001',
                  'th_00000000-0000-7000-8000-000000000001',
                  admittedId
                )
              ).toBeNull()
            );
            expect(
              store.getCommandRequest('task.start', requestId, {
                actorId: 'usr_00000000-0000-7000-8000-000000000001',
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                threadId: 'th_00000000-0000-7000-8000-000000000001',
              })
            ).toBeNull();
            expect(store.getTurnById(admittedId)).toMatchObject({
              id: admittedId,
              status: 'failed',
            });
            expect(store.getTurnById(admittedId).agentSessionId ?? null).toBeNull();
            return;
          }
          const checkpoint = getWorkerCheckpoint(
            checkpointDb,
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001',
            admittedId
          )!;
          expect(checkpoint).toMatchObject({ stage: 'preparing', workerSessionId: null });
          expect(
            store
              .getTurnById(admittedId)
              .items.some((item) => item.id === deriveEntityId('it', ['task-user', admittedId]))
          ).toBe(false);
          /** Replays the original admitted command without another worker launch. */
          const replay = () =>
            app.request(
              ...operationRequest(
                'task.start',
                {
                  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                  threadId: 'th_00000000-0000-7000-8000-000000000001',
                },
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    requestId,
                    input: 'Implement a focused change and run its tests.',
                  }),
                }
              )
            );
          const attemptId = observeExecutionAttempts(coreDb).find(
            (a) => a.turn_id === admittedId
          )!.attempt_id;
          if ('proofGap' in scenario && scenario.proofGap === 'native') {
            for (const patch of [
              {
                worker_process_key_hash: 'retained-process-proof',
                last_accepted_heartbeat_at: new Date().toISOString(),
              },
              { worker_process_key_hash: 'retained-process-proof' },
              { last_accepted_heartbeat_at: new Date().toISOString() },
              { last_worker_sequence: 1 },
              { worker_control_token_hash: 'retained-control-proof' },
              { worker_inference_token_hash: 'retained-inference-proof' },
              { worker_capability_token_hash: 'retained-capability-proof' },
            ]) {
              const columns = Object.keys(patch);
              coreDb.sqlite
                .prepare(
                  `UPDATE scheduler_execution_attempts SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE attempt_id = ?`
                )
                .run(...Object.values(patch), attemptId);
              const before = await replay();
              expect(before.status, 'Native evidence must prevent pre-effect replay.').toBe(409);
              expect(await before.json()).toMatchObject({ code: 'recovery_required' });
              expect(
                getWorkerCheckpoint(
                  checkpointDb,
                  'ws_00000000-0000-7000-8000-000000000001',
                  'th_00000000-0000-7000-8000-000000000001',
                  admittedId
                )
              ).toEqual(checkpoint);
              await expect(
                classifyDirectTaskCheckpointAfterSchedulerRecovery({
                  coreDb,
                  store,
                  workspaceDb: checkpointDb,
                  checkpoint,
                })
              ).rejects.toMatchObject({ code: 'recovery_required' });
              const after = await replay();
              expect(after.status, 'Attempted collection must preserve contradictory proof.').toBe(
                409
              );
              expect(await after.json()).toMatchObject({ code: 'recovery_required' });
              expect(
                getWorkerCheckpoint(
                  checkpointDb,
                  'ws_00000000-0000-7000-8000-000000000001',
                  'th_00000000-0000-7000-8000-000000000001',
                  admittedId
                )
              ).toEqual(checkpoint);
              coreDb.sqlite
                .prepare(
                  `UPDATE scheduler_execution_attempts SET ${columns.map((column) => `${column} = NULL`).join(', ')} WHERE attempt_id = ?`
                )
                .run(attemptId);
            }
            expect(executor.launches).toBe(0);
            expect(prepare).toHaveBeenCalledTimes(1);
            expect(observeExecutionAttempts(coreDb)).toHaveLength(1);
            return;
          }
          if ('proofGap' in scenario && scenario.proofGap === 'input') {
            const row = coreDb.sqlite
              .prepare('SELECT turn_input FROM scheduler_admission_entries WHERE turn_id = ?')
              .get(admittedId) as { turn_input: string };
            const changed = JSON.parse(row.turn_input);
            changed.objective = 'Contradictory retained instruction';
            const changedInput = JSON.stringify(changed);
            coreDb.sqlite
              .prepare('UPDATE scheduler_admission_entries SET turn_input = ? WHERE turn_id = ?')
              .run(changedInput, admittedId);
            const before = await replay();
            expect(before.status, 'Retained checkpoint must reject changed admission input.').toBe(
              409
            );
            expect(await before.json()).toMatchObject({ code: 'recovery_required' });
            expect(
              getWorkerCheckpoint(
                checkpointDb,
                'ws_00000000-0000-7000-8000-000000000001',
                'th_00000000-0000-7000-8000-000000000001',
                admittedId
              )
            ).toEqual(checkpoint);
            coreDb.sqlite
              .prepare('UPDATE scheduler_admission_entries SET turn_input = ? WHERE turn_id = ?')
              .run(row.turn_input, admittedId);
            await expect(
              classifyDirectTaskCheckpointAfterSchedulerRecovery({
                coreDb,
                store,
                workspaceDb: checkpointDb,
                checkpoint,
              })
            ).resolves.toBe('complete');
            expect(
              getWorkerCheckpoint(
                checkpointDb,
                'ws_00000000-0000-7000-8000-000000000001',
                'th_00000000-0000-7000-8000-000000000001',
                admittedId
              )
            ).toBeNull();
            coreDb.sqlite
              .prepare('UPDATE scheduler_admission_entries SET turn_input = ? WHERE turn_id = ?')
              .run(changedInput, admittedId);
            const after = await replay();
            expect(
              after.status,
              'Collected checkpoint must still reject changed admission input.'
            ).toBe(409);
            expect(await after.json()).toMatchObject({ code: 'recovery_required' });
            expect(
              getWorkerCheckpoint(
                checkpointDb,
                'ws_00000000-0000-7000-8000-000000000001',
                'th_00000000-0000-7000-8000-000000000001',
                admittedId
              )
            ).toBeNull();
            expect(executor.launches).toBe(0);
            expect(prepare).toHaveBeenCalledTimes(1);
            expect(observeExecutionAttempts(coreDb)).toHaveLength(1);
            return;
          }
          for (const patch of [
            { disposition: 'unknown', operation_id: 'possible-native-effect' },
            { input_ref: 'unexpected-package' },
            { binding_ref: 'unexpected-binding' },
            { phase: 'closing' },
          ]) {
            const columns = Object.keys(patch);
            coreDb.sqlite
              .prepare(
                `UPDATE scheduler_execution_attempts SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE attempt_id = ?`
              )
              .run(...Object.values(patch), attemptId);
            await expect(
              classifyDirectTaskCheckpointAfterSchedulerRecovery({
                coreDb,
                store,
                workspaceDb: checkpointDb,
                checkpoint,
              })
            ).rejects.toMatchObject({ code: 'recovery_required' });
            const rejected = await replay();
            expect(rejected.status).toBe(409);
            expect(await rejected.json()).toMatchObject({ code: 'recovery_required' });
            expect(
              getWorkerCheckpoint(
                checkpointDb,
                'ws_00000000-0000-7000-8000-000000000001',
                'th_00000000-0000-7000-8000-000000000001',
                admittedId
              )
            ).toEqual(checkpoint);
            coreDb.sqlite
              .prepare(
                `UPDATE scheduler_execution_attempts SET phase = 'closed', disposition = 'not_accepted', operation_id = NULL, input_ref = NULL, binding_ref = NULL WHERE attempt_id = ?`
              )
              .run(attemptId);
          }
          const events = vi.spyOn(store, 'getTurnEvents').mockReturnValueOnce([]);
          await expect(
            classifyDirectTaskCheckpointAfterSchedulerRecovery({
              coreDb,
              store,
              workspaceDb: checkpointDb,
              checkpoint,
            })
          ).rejects.toMatchObject({ code: 'recovery_required' });
          events.mockRestore();
          await expect(
            classifyDirectTaskCheckpointAfterSchedulerRecovery({
              coreDb,
              store,
              workspaceDb: checkpointDb,
              checkpoint: { ...checkpoint, requestInputHash: 'contradictory-hash' },
            })
          ).rejects.toMatchObject({ code: 'recovery_required' });
          if ('replayBeforeCollection' in scenario && scenario.replayBeforeCollection) {
            const response = await replay();
            expect(response.status, await response.clone().text()).toBe(202);
            expect(await response.json()).toMatchObject({
              state: 'failed',
              turn: {
                id: admittedId,
                status: 'failed',
                error: store.getTurnById(admittedId).error,
              },
            });
          } else {
            await expect(
              classifyDirectTaskCheckpointAfterSchedulerRecovery({
                coreDb,
                store: await createDemoStore({ dataRoot }),
                workspaceDb: checkpointDb,
                checkpoint,
              })
            ).resolves.toBe('complete');
          }
          expect(
            getWorkerCheckpoint(
              checkpointDb,
              'ws_00000000-0000-7000-8000-000000000001',
              'th_00000000-0000-7000-8000-000000000001',
              admittedId
            )
          ).toBeNull();
          expect(
            checkpointOwners.listExportableWorkerCheckpoints(
              checkpointDb,
              'ws_00000000-0000-7000-8000-000000000001'
            )
          ).toEqual([]);
          const response = await replay();
          expect(response.status, await response.clone().text()).toBe(202);
          expect(await response.json()).toMatchObject({
            state: 'failed',
            turn: { id: admittedId, status: 'failed', error: store.getTurnById(admittedId).error },
          });
          expect(executor.launches).toBe(0);
          expect(prepare).toHaveBeenCalledTimes(1);
          expect(observeExecutionAttempts(coreDb)).toHaveLength(1);
          // Collected checkpoints do not weaken the retained failure and execution proof.
          const terminalEvents = vi.spyOn(store, 'getTurnEvents').mockReturnValue([]);
          const partial = await replay();
          expect(partial.status).toBe(409);
          expect(await partial.json()).toMatchObject({ code: 'recovery_required' });
          terminalEvents.mockRestore();
          coreDb.sqlite
            .prepare('UPDATE scheduler_execution_attempts SET input_ref = ? WHERE attempt_id = ?')
            .run('unexpected-package-after-collection', attemptId);
          const contradictory = await replay();
          expect(contradictory.status).toBe(409);
          expect(await contradictory.json()).toMatchObject({ code: 'recovery_required' });
          coreDb.sqlite
            .prepare(
              'UPDATE scheduler_execution_attempts SET input_ref = NULL WHERE attempt_id = ?'
            )
            .run(attemptId);
          expect(
            getWorkerCheckpoint(
              checkpointDb,
              'ws_00000000-0000-7000-8000-000000000001',
              'th_00000000-0000-7000-8000-000000000001',
              admittedId
            )
          ).toBeNull();
          expect(executor.launches).toBe(0);
          expect(prepare).toHaveBeenCalledTimes(1);
        } finally {
          checkpointDb.sqlite.close();
        }
      } else {
        await executor.launched.promise;
        expect(executor.launches).toBe(1);
        expect(store.getTurnById(admittedId).id).toBe(admittedId);
      }
    } finally {
      release.resolve();
      executor.completion.resolve();
      await pending;
      if (executor.launches) await executor.finished.promise;
      await setImmediate();
      prepare.mockRestore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

// Restore shared callables before native drain; a timed-out body can still finish later.
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await shutdownControlStoreWorkerClient();
});
