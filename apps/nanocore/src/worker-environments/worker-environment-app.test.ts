import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActivateWorkerEnvironmentResponse,
  PrepareWorkerEnvironmentResponse,
} from '@openkit/app-api-schemas';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import { parse } from 'jsonc-parser';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  listSchedulerExecutionAttemptsForTurn,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from '../runtime/nanohost-session-dispatch.js';
import { resolvePublicNativeEnvironment } from '../runtime/native-environment.js';
import * as schedulerDispatch from '../runtime/scheduler-dispatch-loop.js';
import type { TurnCommandRuntimeContext, TurnStartRuntimeContext } from '../runtime/types.js';
import { writeWorkerImageSettlement } from '../runtime/worker-image-settlements.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  type WorkerStorageLayout,
} from '../runtime/worker-storage-bindings.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  ensureUserQuickChatWorkspace,
  recordWorkspaceOwnerMembership,
} from '../workspace-membership.js';

const USER_ID = 'user_worker_environment_app';
const OWNER_SESSION_HEADER = 'x-openkit-worker-environment-owner-session';
const AGENT_ID = 'agent_codex_host';
const CONFIGURATION_FILE_ID = 'agents/codex.agent.jsonc';
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const DECLARATION = {
  kind: 'reference' as const,
  pullPolicy: 'if-not-present' as const,
  ref: 'registry.example.com/openkit/worker-codex:browser',
};
const IMAGE_INSPECTION = {
  digest: IMAGE_DIGEST,
  platform: { architecture: 'arm64', os: 'linux' },
  storageLayout: {
    family: 'openkit-worker',
    gid: 1000,
    targets: [{ target: '/sandbox' }, { target: '/workspace' }],
    uid: 1000,
    version: '1',
    workingDirectory: '/tmp/openkit-bootstrap',
  },
} as const;
const STORAGE_LAYOUT: WorkerStorageLayout = {
  family: IMAGE_INSPECTION.storageLayout.family,
  gid: IMAGE_INSPECTION.storageLayout.gid,
  platform: IMAGE_INSPECTION.platform,
  targets: IMAGE_INSPECTION.storageLayout.targets,
  uid: IMAGE_INSPECTION.storageLayout.uid,
  version: IMAGE_INSPECTION.storageLayout.version,
  workingDirectory: IMAGE_INSPECTION.storageLayout.workingDirectory,
};

interface ResidentStorageCleanup {
  readonly attachmentGeneration: number;
  readonly expectedRevision: number;
  readonly harnessInstanceId: string;
  readonly sandboxBindingRef: string;
  readonly storageRef: string;
}

/** Simulates an acknowledged interrupt whose terminal cleanup remains independently observable. */
class DeferredInterruptTurnExecutor extends SimulatedTurnExecutor {
  public readonly startedTurnIds: string[] = [];
  public interruptCount = 0;
  public releasedStorageRevision: number | null = null;
  private pendingInterrupt: {
    readonly context: TurnCommandRuntimeContext;
    readonly store: FsStore;
    readonly turnId: string;
  } | null = null;
  private residentCleanup: ResidentStorageCleanup | null = null;

  public constructor(private readonly fixtureCoreDb: CoreDb) {
    super({ coreDb: fixtureCoreDb });
  }

  /** Leaves each scheduler-dispatched fixture Turn running until the test supplies its terminal. */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    _input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    this.startedTurnIds.push(turnId);
    const turn = store.getTurnById(turnId);
    const agentSessionId = context?.agentSessionId;
    if (!agentSessionId) throw new Error('Scheduler AgentSession identity is absent.');
    let session: ReturnType<FsStore['getAgentSession']> | null = null;
    try {
      session = store.getAgentSession(agentSessionId);
    } catch {
      session = null;
    }
    const now = new Date().toISOString();
    if (session) {
      store.updateAgentSession(agentSessionId, { status: 'busy', updatedAt: now });
    } else {
      store.createAgentSession({
        id: agentSessionId,
        agentId: context.agentSetup?.manifest.id ?? AGENT_ID,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        status: 'busy',
        message: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    store.updateTurn(turnId, { agentSessionId, status: 'running' });
    if (!context?.attemptId) throw new Error('Current execution attempt is absent.');
    // This consumer fixture models a submitted resident worker; production still owns its Core correlation.
    const attempt = recordSchedulerExecutionOperation(this.fixtureCoreDb, {
      attemptId: context.attemptId,
      operationId: `submit:${turnId}`,
      submission: true,
    });
    const observed = await this.submit({
      ...schedulerExecutionCorrelation(attempt),
      deadline: attempt.deadline!,
    });
    acceptSchedulerExecutionObservation(this.fixtureCoreDb, observed);
    context.onSubmissionSettled?.();
  }

  /** Acknowledges the interrupt command without claiming that runtime cleanup is terminal. */
  public override async interruptTurn(
    store: FsStore,
    turnId: string,
    context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    this.interruptCount += 1;
    this.pendingInterrupt = { context, store, turnId };
  }

  /** Supplies the exact attached association whose runtime cleanup follows terminalization. */
  public setResidentCleanup(input: ResidentStorageCleanup): void {
    this.residentCleanup = input;
  }

  /**
   * Emits the terminal outcome and proves the old attachment cleanup before continuations run.
   *
   * @param terminalStatus Sealed terminal the predecessor reaches; a concurrent cancel seals `cancelled`.
   */
  public async finishInterrupt(
    terminalStatus: 'cancelled' | 'interrupted' = 'interrupted'
  ): Promise<void> {
    const pending = this.pendingInterrupt;
    const cleanup = this.residentCleanup;
    if (!pending || !cleanup) throw new Error('Resident interrupt fixture is incomplete.');
    this.fixtureCoreDb.sqlite
      .prepare(
        `UPDATE agent_session_runtime_bindings
         SET lifecycle_state = 'open', current_turn_id = NULL, current_attempt_id = NULL,
             cleanup_state = 'clean', updated_at = ?
         WHERE harness_instance_id = ?`
      )
      .run(new Date().toISOString(), cleanup.harnessInstanceId);
    this.fixtureCoreDb.sqlite
      .prepare(
        'UPDATE harness_instance_records SET active_turn_count = 0 WHERE harness_instance_id = ?'
      )
      .run(cleanup.harnessInstanceId);
    const released = releaseWorkerStorageAttachment(this.fixtureCoreDb, {
      attachmentGeneration: cleanup.attachmentGeneration,
      cleanupProved: true,
      expectedRevision: cleanup.expectedRevision,
      sandboxBindingRef: cleanup.sandboxBindingRef,
      storageRef: cleanup.storageRef,
    });
    this.releasedStorageRevision = released.revision;
    if (terminalStatus === 'cancelled') {
      const running = pending.store.getTurnById(pending.turnId);
      if (running.agentSessionId) {
        const agentSession = pending.store.updateAgentSession(running.agentSessionId, {
          // terminalizeGovernedWorkerTurn maps a cancelled outcome to an interrupted AgentSession.
          message: 'The worker turn was cancelled.',
          status: 'interrupted',
          updatedAt: new Date().toISOString(),
        });
        pending.store.emitTurnEvent(pending.turnId, {
          data: { type: 'agent-session-updated', agentSession },
          event: 'agent.session.updated',
          requestId: pending.context.requestId,
          threadId: running.threadId,
          turnId: pending.turnId,
          workspaceId: running.workspaceId,
        });
      }
      const cancelled = pending.store.updateTurn(pending.turnId, {
        completedAt: new Date().toISOString(),
        status: 'cancelled',
      });
      pending.store.emitTurnEvent(
        pending.turnId,
        {
          data: { type: 'turn-completed', stopReason: 'aborted', turn: cancelled },
          event: 'turn.completed',
          requestId: pending.context.requestId,
          threadId: cancelled.threadId,
          turnId: pending.turnId,
          workspaceId: cancelled.workspaceId,
        },
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      );
    } else {
      await super.interruptTurn(pending.store, pending.turnId, pending.context);
    }
    const attempt = listSchedulerExecutionAttemptsForTurn(this.fixtureCoreDb, {
      workspaceId: pending.store.getTurnById(pending.turnId).workspaceId,
      threadId: pending.store.getTurnById(pending.turnId).threadId,
      turnId: pending.turnId,
    })[0]!;
    const closing = markSchedulerExecutionAttemptClosing(this.fixtureCoreDb, {
      attemptId: attempt.attemptId,
      cause: `turn-${terminalStatus}`,
      outcomeRef: `turn:${terminalStatus}`,
    });
    // No output/evidence streams exist in this modeled worker. Exact resident occupancy and
    // storage cleanup above settle its only physical fixture state before the modeled fence.
    expect(pending.store.getTurnById(pending.turnId).status).toBe(terminalStatus);
    expect(
      this.fixtureCoreDb.sqlite
        .prepare(
          'SELECT active_turn_count FROM harness_instance_records WHERE harness_instance_id = ?'
        )
        .get(cleanup.harnessInstanceId)
    ).toEqual({ active_turn_count: 0 });
    const proof = {
      terminalHandoff: true,
      output: true,
      evidence: true,
      outsideWorkspaceCollection: true,
      integrationDrain: true,
      routesRevoked: true,
    } as const;
    const correlation = schedulerExecutionCorrelation(closing);
    const release = await this.release({ ...correlation, proof });
    closeSchedulerExecutionAttemptWithFence(this.fixtureCoreDb, {
      correlation,
      proof,
      fenceRef: release.fenceRef!,
    });
  }
}

/** Returns an auth server that leaves bearer-token authentication to NanoCore. */
function noSessionAuth(): BetterAuthServer {
  return {
    api: { getSession: async () => null },
    handler: async () => new Response(null, { status: 404 }),
  };
}

/** Returns the current-user session used to intersect Workspace and deployment-admin authority. */
function ownerSessionAuth(): BetterAuthServer {
  return {
    api: {
      getSession: async ({ headers }) =>
        headers.get(OWNER_SESSION_HEADER) === '1'
          ? { session: { id: 'session_worker_environment_owner' }, user: { id: USER_ID } }
          : null,
    },
    handler: async () => new Response(null, { status: 404 }),
  };
}

/** Inserts the active canonical user that owns this integration fixture. */
function insertCanonicalUser(coreDb: CoreDb): void {
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, image,
        created_at, updated_at, kind, last_seen_at
      ) VALUES (?, ?, ?, false, NULL, ?, ?, 'human', NULL)`
    )
    .run(USER_ID, 'Worker Environment Owner', 'worker-environment@example.com', now, now);
}

/** Creates the fixed image acquire and inspect boundary used by the real App composition. */
function createNanoHostDispatch(
  coreDb: CoreDb,
  effect: ReturnType<typeof vi.fn>
): NanoHostSessionDispatch {
  return {
    async effect(requestOrConnection, carriedRequest) {
      const request = (carriedRequest ?? requestOrConnection) as NanoHostSessionEffectRequest;
      const result = (await effect(request)) as { digest?: string };
      if (
        request.imageSettlement &&
        (request.kind === 'image.acquire' || request.kind === 'image.build')
      )
        writeWorkerImageSettlement(coreDb, {
          ...request.imageSettlement,
          requestId: request.requestId,
          operation: request.kind,
          outcome: { kind: 'success', imageDigest: result.digest! },
        });
      return result;
    },
    async fileExportResult() {},
    async imageBuildInput() {
      throw new Error('Unexpected image build input request.');
    },
    async poll() {
      return null;
    },
    async result() {},
    async route() {
      throw new Error('Unexpected NanoHost semantic route.');
    },
  };
}

/** Computes the runtime configuration service's exact content revision. */
function contentRevision(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Persists the same credential-free model catalog used before and after safe config reload. */
function writeReloadableModelCatalog(dataRoot: string): void {
  writeFileSync(
    join(dataRoot, 'config', 'providers', 'worker-environment-fixture.provider.jsonc'),
    `${JSON.stringify(
      {
        displayName: 'Worker environment fixture provider',
        id: 'worker-environment-fixture',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(dataRoot, 'config', 'gateway.jsonc'),
    `${JSON.stringify(
      {
        defaultLogicalModelId: 'smart',
        enabled: true,
        logicalModels: [
          {
            contextManagement: [{ compactThreshold: 8_000, type: 'compaction' }],
            displayName: 'Smart',
            id: 'smart',
            routes: [
              {
                id: 'worker-environment-fixture',
                providerModel: 'openai/gpt-5.2',
                providerProfileId: 'worker-environment-fixture',
              },
            ],
          },
        ],
        requiredFeatures: [],
        schemaVersion: 1,
      },
      null,
      2
    )}\n`
  );
}

/** Creates the attached persistent association and runtime lineage for one active Turn. */
function attachResidentStorage(input: {
  readonly agentSessionId: string;
  readonly coreDb: CoreDb;
  readonly leaseId: string;
  readonly sandboxBindingRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceId: string;
}): ReturnType<typeof activateWorkerStorageAttachment> & {
  readonly harnessInstanceId: string;
} {
  const now = new Date().toISOString();
  input.coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_runtime_targets (
         target_id, identity_id, deployment_id, connection_generation,
         predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
       ) VALUES ('target_local', 'identity_local', 'deployment_local', 1, 1, 1, 1, ?, ?, 1)`
    )
    .run('a'.repeat(64), now);
  const created = createWorkerStorageBinding(input.coreDb, {
    deploymentId: 'deployment_local',
    layout: STORAGE_LAYOUT,
    now,
    runtimeTargetId: 'target_local',
    workspaceId: input.workspaceId,
  });
  const reserved = reserveWorkerStorageAttachment(input.coreDb, {
    agentSessionId: input.agentSessionId,
    authorizeContributor: () => true,
    expectedRevision: created.revision,
    layout: STORAGE_LAYOUT,
    now,
    purpose: 'work',
    responsibleUserId: USER_ID,
    runtimeTargetId: 'target_local',
    storageRef: created.storageRef,
    threadId: input.threadId,
    workspaceId: input.workspaceId,
  });
  const attached = activateWorkerStorageAttachment(input.coreDb, {
    attachmentGeneration: reserved.attachmentGeneration,
    expectedRevision: reserved.revision,
    now,
    sandboxBindingRef: input.sandboxBindingRef,
    storageRef: created.storageRef,
    targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
  });
  const harnessInstanceId = 'harness_worker_environment_resident';
  input.coreDb.sqlite
    .prepare(
      `INSERT INTO sandbox_runtime_records (
         sandbox_runtime_id, runtime_target_id, sandbox_binding_ref,
         sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest, origin_physical_epoch,
         environment_class, max_open_sessions, max_harnesses, max_active_turns,
         lifecycle_state, health_state, drain_state, cleanup_state, created_at, updated_at
       ) VALUES (
         'sandbox_runtime_worker_environment', 'target_local', ?,
         'sandbox_integration_worker_environment', 'compatibility_worker_environment', ?, ?,
         'worker', 8, 8, 1, 'open', 'ready', 'accepting', 'clean', ?, ?
       )`
    )
    .run(input.sandboxBindingRef, `sha256:${'f'.repeat(64)}`, 'a'.repeat(64), now, now);
  input.coreDb.sqlite
    .prepare(
      `INSERT INTO harness_instance_records (
         harness_instance_id, sandbox_runtime_id, harness_binding_ref,
         harness_compatibility_key, runtime_family, adapter_id, adapter_version,
         protocol_version, capabilities_json, max_open_sessions, max_active_turns,
         open_session_count, active_turn_count, lifecycle_state, drain_state,
         next_sequence, operation_state, created_at, updated_at
       ) VALUES (
         ?, 'sandbox_runtime_worker_environment', 'harness_binding_worker_environment',
         'harness_compatibility_worker_environment', 'codex', 'codex', '1',
         1, '[]', 8, 1, 1, 1, 'open', 'accepting', 1, 'idle', ?, ?
       )`
    )
    .run(harnessInstanceId, now, now);
  input.coreDb.sqlite
    .prepare(
      `INSERT INTO agent_session_runtime_bindings (
         agent_session_runtime_binding_id, harness_instance_id, agent_session_id,
         workspace_id, thread_id, agent_session_compatibility_key,
         effective_setup_generation, native_handle_state, lifecycle_state,
         current_turn_id, current_attempt_id, next_turn_sequence, cleanup_state,
         created_at, updated_at, image_digest
       ) VALUES (
         'binding_worker_environment', ?, ?, ?, ?, 'session_compatibility_worker_environment',
         1, 'ready', 'active', ?, ?, 1, 'clean', ?, ?, 'sha256:${'a'.repeat(64)}'
       )`
    )
    .run(
      harnessInstanceId,
      input.agentSessionId,
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.leaseId,
      now,
      now
    );
  return { ...attached, harnessInstanceId };
}

describe('Worker environment App composition', () => {
  it.each([
    false,
    true,
  ])('prepares and activates confirmed defaults with already-pinned=%s, replays, and denies non-admin entry', async (alreadyPinned) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertCanonicalUser(coreDb);
      const store = new FsStore({ dataRoot });
      ensureUserQuickChatWorkspace({ coreDb, store, userId: USER_ID });
      const privateWorkspace = store.ensureQuickChatWorkspace(USER_ID);
      const administrationThread = store.createThread(
        privateWorkspace.id,
        'Administration',
        'thread_worker_environment_app',
        'administration',
        { privateOwnerUserId: USER_ID, visibility: 'private' }
      );
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: USER_ID,
        scope: 'server-admin',
        workspaceIds: [],
      });
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: USER_ID,
        scope: 'workspace',
        workspaceIds: [privateWorkspace.id],
      });
      const agentPath = join(dataRoot, 'config', CONFIGURATION_FILE_ID);
      if (alreadyPinned) {
        const manifest = parse(readFileSync(agentPath, 'utf8'));
        manifest.runtime.image = { kind: 'reference', pullPolicy: 'never', ref: IMAGE_DIGEST };
        writeFileSync(agentPath, JSON.stringify(manifest, null, 2));
      }
      const initialAgentContent = readFileSync(agentPath, 'utf8');
      const initialRevision = contentRevision(initialAgentContent);
      const values = { PUBLIC_SETTING: 'confirmed-native-default' };
      const defaultsDigest = `sha256:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
      const nanoHostEffect = vi.fn(async (request: NanoHostSessionEffectRequest) => {
        if (request.kind === 'image.acquire') return { digest: IMAGE_DIGEST };
        if (request.kind === 'image.inspect')
          return {
            ...IMAGE_INSPECTION,
            environmentDefaults: {
              defaultsDigest,
              values,
            },
          };
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      });
      const createResponses = vi.fn(async () => {
        throw new Error('Private administration provider dispatch must remain denied.');
      });
      const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
      const actualReload = runtimeConfigManager.reload.bind(runtimeConfigManager);
      const nativeAtReload: ReturnType<typeof resolvePublicNativeEnvironment>[] = [];
      const reload = vi.spyOn(runtimeConfigManager, 'reload').mockImplementation((input) => {
        nativeAtReload.push(
          resolvePublicNativeEnvironment(
            coreDb,
            AuthoredAgentConfigSchema.parse(parse(readFileSync(agentPath, 'utf8')))
          )
        );
        return actualReload(input);
      });
      const app = createApp({
        runtimeConfigManager,
        auth: noSessionAuth(),
        coreDb,
        dataRoot,
        llmGatewayDispatcher: { createResponses },
        mode: 'server',
        nanoHostSessionDispatch: createNanoHostDispatch(coreDb, nanoHostEffect),
        store,
      });
      const adminHeaders = {
        authorization: `Bearer ${admin.secret}`,
        'content-type': 'application/json',
      };

      const preparedResponse = await app.request(
        ...operationRequest(
          'worker-environment.prepare',
          {},
          {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({
              administrationThreadId: administrationThread.id,
              configuration: {
                expectedRevision: initialRevision,
                fileId: CONFIGURATION_FILE_ID,
              },
              declaration: DECLARATION,
              replaceNow: null,
              requestId: '11111111-1111-4111-8111-111111111111',
              target: { agentId: AGENT_ID, kind: 'agent' },
            }),
          }
        )
      );
      const prepared = (await preparedResponse.json()) as PrepareWorkerEnvironmentResponse;

      expect(preparedResponse.status).toBe(200);
      expect(prepared).toMatchObject({
        affectedStorage: [],
        configuration: {
          expectedRevision: initialRevision,
          fileId: CONFIGURATION_FILE_ID,
        },
        image: {
          ...IMAGE_INSPECTION,
          environmentDefaults: {
            defaultsDigest,
            classification: 'unadmitted',
            names: ['PUBLIC_SETTING'],
          },
        },
        replaceNow: null,
        target: { agentId: AGENT_ID, kind: 'agent' },
      });
      expect(prepared.authoredCandidate.artifactVersion).toBe(1);
      expect(prepared.resolvedCandidate.artifactVersion).toBe(1);
      expect(prepared.authoredCandidate.artifactId).not.toBe(prepared.resolvedCandidate.artifactId);
      expect(
        store
          .listArtifacts(privateWorkspace.id)
          .map((artifact) => JSON.parse(artifact.content.body) as { kind?: string })
          .map((artifact) => artifact.kind)
      ).toEqual(['worker-environment-authored-candidate', 'worker-environment-resolved-candidate']);
      expect(nanoHostEffect.mock.calls.map(([request]) => request.kind)).toEqual([
        'image.acquire',
        'image.inspect',
      ]);

      if (alreadyPinned) {
        expect(() =>
          resolvePublicNativeEnvironment(
            coreDb,
            AuthoredAgentConfigSchema.parse(parse(initialAgentContent))
          )
        ).toThrow(
          expect.objectContaining({ code: 'worker_environment_preparation_required', status: 409 })
        );
      }
      const prepareRequestId = '11111111-1111-4111-8111-111111111111';
      const logicalPreparation = {
        administrationThreadId: administrationThread.id,
        requestId: prepareRequestId,
        configuration: prepared.configuration,
        declaration: DECLARATION,
        target: prepared.target,
      };
      const logicalRecovery = {
        administrationThreadId: administrationThread.id,
        requestId: '33333333-3333-4333-8333-333333333333',
        recoverFrom: prepared.authoredCandidate,
      };
      const beforeArtifacts = store.listArtifacts(privateWorkspace.id);
      const beforeTurns = store.listThreadTurns(privateWorkspace.id, administrationThread.id);
      const beforeEffects = nanoHostEffect.mock.calls.length;
      for (const [operation, input] of [
        ['worker-environment.prepare', logicalPreparation],
        ['worker-environment.recover', logicalRecovery],
      ] as const) {
        const response = await app.request(
          ...operationRequest(operation, {}, { headers: adminHeaders, body: JSON.stringify(input) })
        );
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toMatchObject({
          authoredCandidate: prepared.authoredCandidate,
          resolvedCandidate: prepared.resolvedCandidate,
          requestId: input.requestId,
          replaceNow: null,
        });
        const remote = await app.request('/mcp', {
          method: 'POST',
          headers: { ...adminHeaders, accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'call', arguments: { operation, input } },
          }),
        });
        expect(remote.status).toBe(200);
        const remoteBody = await remote.json();
        expect(remoteBody.result.isError).not.toBe(true);
        expect(JSON.parse(remoteBody.result.content[0].text)).toEqual(result);
        const conflict = await app.request(`/api/app/operations/${operation}`, {
          method: 'POST',
          headers: {
            ...adminHeaders,
            'x-openkit-request-id': '44444444-4444-4444-8444-444444444444',
          },
          body: JSON.stringify(input),
        });
        expect(conflict.status).toBe(403);
        expect(await conflict.json()).toMatchObject({
          code: 'bound_input_conflict',
          message: 'Request identity conflicts with its header.',
        });
      }
      for (const operation of [
        'worker-environment.prepare',
        'worker-environment.recover',
      ] as const) {
        const input =
          operation === 'worker-environment.prepare'
            ? { ...logicalPreparation, requestId: logicalRecovery.requestId }
            : { ...logicalRecovery, requestId: prepareRequestId };
        const httpConflict = await app.request(
          ...operationRequest(operation, {}, { headers: adminHeaders, body: JSON.stringify(input) })
        );
        expect(httpConflict.status).toBe(409);
        expect(await httpConflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
        const remoteConflict = await app.request('/mcp', {
          method: 'POST',
          headers: { ...adminHeaders, accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'call', arguments: { operation, input } },
          }),
        });
        const remoteBody = await remoteConflict.json();
        expect(remoteBody.result.isError).toBe(true);
        expect(JSON.parse(remoteBody.result.content[0].text)).toMatchObject({
          code: 'idempotency_key_conflict',
          status: 409,
        });
      }
      const foreignUserId = 'user_worker_environment_foreign';
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (id, display_name, email, email_verified, image, created_at, updated_at, kind, last_seen_at) VALUES (?, 'Foreign Administrator', 'foreign@example.test', false, NULL, ?, ?, 'human', NULL)`
        )
        .run(foreignUserId, Date.now(), Date.now());
      ensureUserQuickChatWorkspace({ coreDb, store, userId: foreignUserId });
      const foreignHome = store.ensureQuickChatWorkspace(foreignUserId);
      const foreignThread = store.createThread(
        foreignHome.id,
        'Foreign administration',
        'thread_foreign_administration',
        'administration',
        { visibility: 'private', privateOwnerUserId: foreignUserId }
      );
      const foreignAdmin = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: foreignUserId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      for (const [operation, input] of [
        ['worker-environment.prepare', logicalPreparation],
        ['worker-environment.recover', logicalRecovery],
      ] as const) {
        for (const [secret, refusedInput, status, code] of [
          [workspaceToken.secret, input, 403, 'deployment_admin_required'],
          [
            foreignAdmin.secret,
            operation === 'worker-environment.recover'
              ? {
                  ...input,
                  administrationThreadId: foreignThread.id,
                  requestId: '55555555-5555-4555-8555-555555555555',
                }
              : { ...input, requestId: '66666666-6666-4666-8666-666666666666' },
            404,
            'not_found',
          ],
        ] as const) {
          const refusal = await app.request(
            ...operationRequest(
              operation,
              {},
              {
                headers: { ...adminHeaders, authorization: `Bearer ${secret}` },
                body: JSON.stringify(refusedInput),
              }
            )
          );
          expect(refusal.status).toBe(status);
          expect(await refusal.json()).toMatchObject({ code });
          const remote = await app.request('/mcp', {
            method: 'POST',
            headers: {
              ...adminHeaders,
              authorization: `Bearer ${secret}`,
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'call', arguments: { operation, input: refusedInput } },
            }),
          });
          const remoteBody = await remote.json();
          expect(remoteBody.result.isError).toBe(true);
          expect(JSON.parse(remoteBody.result.content[0].text)).toMatchObject({ status, code });
          expect(store.listThreadTurns(foreignHome.id, foreignThread.id)).toEqual([]);
        }
      }
      expect(nanoHostEffect.mock.calls).toHaveLength(beforeEffects);
      expect(store.listArtifacts(privateWorkspace.id)).toEqual(beforeArtifacts);
      expect(store.listThreadTurns(privateWorkspace.id, administrationThread.id)).toEqual(
        beforeTurns
      );

      const activationInput = {
        affectedStorage: prepared.affectedStorage,
        configuration: prepared.configuration,
        confirmation: prepared.activationConfirmation,
        replaceNow: prepared.replaceNow,
        requestId: '22222222-2222-4222-8222-222222222222',
        resolvedCandidate: prepared.resolvedCandidate,
        target: prepared.target,
      };
      const activatedResponse = await app.request(
        ...operationRequest(
          'worker-environment.activate',
          {},
          {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify(activationInput),
          }
        )
      );
      const activated = (await activatedResponse.json()) as ActivateWorkerEnvironmentResponse;
      const activatedAgentContent = readFileSync(agentPath, 'utf8');

      expect(activatedResponse.status, JSON.stringify(activated)).toBe(200);
      expect(activated).toMatchObject({
        affected: [],
        configuration: {
          fileId: CONFIGURATION_FILE_ID,
          revision: contentRevision(activatedAgentContent),
        },
        replaceNow: null,
        requestId: '22222222-2222-4222-8222-222222222222',
        resolvedCandidate: prepared.resolvedCandidate,
        target: prepared.target,
      });
      expect(parse(activatedAgentContent)).toMatchObject({
        id: AGENT_ID,
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: IMAGE_DIGEST },
        },
      });
      if (alreadyPinned) {
        expect(activatedAgentContent).toBe(initialAgentContent);
        expect(contentRevision(activatedAgentContent)).toBe(initialRevision);
      } else {
        expect(activatedAgentContent).not.toBe(initialAgentContent);
      }
      expect(
        resolvePublicNativeEnvironment(
          coreDb,
          AuthoredAgentConfigSchema.parse(parse(activatedAgentContent))
        )
      ).toEqual({
        imageDigest: IMAGE_DIGEST,
        defaultsDigest,
        values,
      });
      expect(nativeAtReload).toEqual([{ imageDigest: IMAGE_DIGEST, defaultsDigest, values }]);
      expect(reload).toHaveReturnedWith(expect.objectContaining({ status: 'applied' }));
      expect(reload).toHaveBeenCalledTimes(1);
      const effectsBeforeReplay = nanoHostEffect.mock.calls.length;
      const replay = await app.request(
        ...operationRequest(
          'worker-environment.activate',
          {},
          {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify(activationInput),
          }
        )
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(activated);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(nanoHostEffect).toHaveBeenCalledTimes(effectsBeforeReplay);
      expect(readFileSync(agentPath, 'utf8')).toBe(activatedAgentContent);
      const resultArtifacts = store
        .listArtifacts(privateWorkspace.id)
        .filter((artifact) => artifact.title === 'Worker environment activation result');
      expect(resultArtifacts).toHaveLength(1);
      expect(JSON.parse(resultArtifacts[0]!.content.body)).toEqual(activated);

      const denied = await app.request(
        ...operationRequest(
          'administration.conversation-submit',
          {},
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${workspaceToken.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              input: 'Prepare another Worker environment.',
              requestId: '33333333-3333-4333-8333-333333333333',
              threadId: administrationThread.id,
            }),
          }
        )
      );

      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      expect(createResponses).not.toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'interrupted',
    'cancelled',
  ] as const)('waits for resident %s cleanup before admitting a same-storage successor', async (terminalStatus) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-replacement-app-'));
    const coreDb = openCoreDb(dataRoot);
    const dispatchObservation = vi.spyOn(schedulerDispatch, 'runSchedulerDispatchLoop');
    let responseSettled = false;

    try {
      applyMigrations(coreDb);
      insertCanonicalUser(coreDb);
      const store = createDemoStore({ dataRoot }, USER_ID);
      ensureUserQuickChatWorkspace({ coreDb, store, userId: USER_ID });
      const privateWorkspace = store.ensureQuickChatWorkspace(USER_ID);
      const administrationThread = store.createThread(
        privateWorkspace.id,
        'Administration',
        'thread_worker_environment_replacement',
        'administration',
        { privateOwnerUserId: USER_ID, visibility: 'private' }
      );
      const productWorkspace = store
        .listWorkspaces()
        .find((workspace) => workspace.kind === 'code');
      const productThread = productWorkspace
        ? store.listThreads(productWorkspace.id)[0]
        : undefined;
      if (!productWorkspace || !productThread) throw new Error('Demo product Workspace is absent.');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: USER_ID,
        workspaceId: productWorkspace.id,
      });
      createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: USER_ID,
        scope: 'server-admin',
        workspaceIds: [],
      });
      writeReloadableModelCatalog(dataRoot);
      const sessionHeaders = { [OWNER_SESSION_HEADER]: '1' };
      const agentPath = join(dataRoot, 'config', CONFIGURATION_FILE_ID);
      const initialRevision = contentRevision(readFileSync(agentPath, 'utf8'));
      const nanoHostEffect = vi.fn(async (request: NanoHostSessionEffectRequest) => {
        if (request.kind === 'image.acquire') return { digest: IMAGE_DIGEST };
        if (request.kind === 'image.inspect')
          return {
            ...IMAGE_INSPECTION,
            environmentDefaults: {
              defaultsDigest:
                'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
              values: {},
            },
          };
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      });
      const executor = new DeferredInterruptTurnExecutor(coreDb);
      const agentSetupOptions = {
        logicalModelId: 'smart',
        privateRoute: {
          providerModel: 'openai/gpt-5.2',
          providerProfileId: 'worker-environment-fixture',
        },
      } as const;
      const agentSetup = createTestAgentSetup(agentSetupOptions);
      admitTestNativeEnvironment(coreDb, agentSetup.manifest, {}, IMAGE_DIGEST);
      const app = createApp({
        agentManifests: [agentSetup.manifest],
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        gatewayConfig: createTestGatewayConfig(agentSetupOptions),
        mode: 'server',
        nanoHostSessionDispatch: createNanoHostDispatch(coreDb, nanoHostEffect),
        openKitConfig: { defaults: { defaultAgentId: AGENT_ID } },
        providerRegistry: new ProviderRegistry([
          {
            defaultModel: 'openai/gpt-5.2',
            displayName: 'Worker environment fixture provider',
            id: 'worker-environment-fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        store,
        turnExecutor: executor,
      });

      const predecessorResponse = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            headers: { ...sessionHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
              input: 'Keep the resident Worker active until replacement.',
              requestId: '44444444-4444-4444-8444-444444444444',
              threadId: productThread.id,
              workspaceId: productWorkspace.id,
            }),
          }
        )
      );
      const predecessor = (await predecessorResponse.json()) as {
        id: string;
        status: string;
      };
      expect(predecessorResponse.status, JSON.stringify(predecessor)).toBe(202);
      await vi.waitFor(() =>
        expect(store.getTurnById(predecessor.id)).toMatchObject({
          agentSessionId: expect.any(String),
          status: 'running',
        })
      );
      const storedPredecessor = store.getTurnById(predecessor.id);
      expect(storedPredecessor).toMatchObject({
        agentSessionId: expect.any(String),
        status: 'running',
      });
      if (!storedPredecessor.agentSessionId) throw new Error('Predecessor AgentSession is absent.');
      const predecessorLease = listSchedulerExecutionAttemptsForTurn(coreDb, {
        threadId: productThread.id,
        turnId: predecessor.id,
        workspaceId: productWorkspace.id,
      })[0];
      if (!predecessorLease) throw new Error('Predecessor scheduler lease is absent.');
      const attached = attachResidentStorage({
        agentSessionId: storedPredecessor.agentSessionId,
        coreDb,
        leaseId: predecessorLease.attemptId,
        sandboxBindingRef: predecessorLease.bindingRef!,
        threadId: productThread.id,
        turnId: predecessor.id,
        workspaceId: productWorkspace.id,
      });
      executor.setResidentCleanup({
        attachmentGeneration: attached.attachmentGeneration,
        expectedRevision: attached.revision,
        harnessInstanceId: attached.harnessInstanceId,
        sandboxBindingRef: predecessorLease.bindingRef!,
        storageRef: attached.storageRef,
      });

      const preparedResponse = await app.request(
        ...operationRequest(
          'worker-environment.prepare',
          {},
          {
            method: 'POST',
            headers: { ...sessionHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
              administrationThreadId: administrationThread.id,
              configuration: {
                expectedRevision: initialRevision,
                fileId: CONFIGURATION_FILE_ID,
              },
              declaration: DECLARATION,
              replaceNow: {
                prompt: 'Continue with the resolved Worker image.',
                threadId: productThread.id,
                workspaceId: productWorkspace.id,
              },
              requestId: '55555555-5555-4555-8555-555555555555',
              target: { agentId: AGENT_ID, kind: 'agent' },
            }),
          }
        )
      );
      const prepared = (await preparedResponse.json()) as PrepareWorkerEnvironmentResponse;
      expect(preparedResponse.status).toBe(200);
      expect(prepared.affectedStorage).toEqual([
        { expectedRevision: attached.revision, storageRef: attached.storageRef },
      ]);

      const activationResponsePromise = app.request(
        ...operationRequest(
          'worker-environment.activate',
          {},
          {
            method: 'POST',
            headers: { ...sessionHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
              affectedStorage: prepared.affectedStorage,
              configuration: prepared.configuration,
              confirmation: prepared.activationConfirmation,
              replaceNow: prepared.replaceNow,
              requestId: '66666666-6666-4666-8666-666666666666',
              resolvedCandidate: prepared.resolvedCandidate,
              target: prepared.target,
            }),
          }
        )
      );
      void activationResponsePromise.then(() => {
        responseSettled = true;
      });
      await vi.waitFor(() => expect(executor.interruptCount).toBe(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const beforeTerminalTurnIds = store
        .listThreadTurns(productWorkspace.id, productThread.id)
        .map((turn) => turn.id);

      await executor.finishInterrupt(terminalStatus);
      await vi.waitFor(() =>
        expect(
          responseSettled,
          'Activation acknowledges after predecessor fencing and successor receipt publication.'
        ).toBe(true)
      );
      const activationResponse = await activationResponsePromise;
      const activation = (await activationResponse.json()) as ActivateWorkerEnvironmentResponse;
      await vi.waitFor(() => expect(executor.startedTurnIds).toHaveLength(2));
      const productTurns = store.listThreadTurns(productWorkspace.id, productThread.id);
      const successor = productTurns.find((turn) => turn.id !== predecessor.id);

      expect(beforeTerminalTurnIds).toEqual([predecessor.id]);
      expect(activationResponse.status).toBe(200);
      expect(activation).toMatchObject({
        affected: [
          {
            expectedRevision: attached.revision,
            storageRef: attached.storageRef,
          },
        ],
        configuration: { fileId: CONFIGURATION_FILE_ID },
      });
      expect(parse(readFileSync(agentPath, 'utf8'))).toMatchObject({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: IMAGE_DIGEST },
        },
      });
      expect(store.getTurnById(predecessor.id).status).toBe(terminalStatus);
      if (!successor) throw new Error('Same-storage successor Turn is absent.');
      await vi.waitFor(() =>
        expect(store.getTurnById(successor.id)).toMatchObject({ status: 'running' })
      );
      expect(executor.startedTurnIds).toEqual([predecessor.id, successor.id]);
      expect(requireSchedulerExecutionAttempt(coreDb, predecessorLease.attemptId)).toMatchObject({
        phase: 'closed',
        terminalCause: `turn-${terminalStatus}`,
        outcomeRef: `turn:${terminalStatus}`,
        fenceRef: expect.any(String),
      });
      const successorAdmission = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        statuses: ['admitted'],
        workspaceId: productWorkspace.id,
      }).find((entry) => entry.turnId === successor.id);
      expect(successorAdmission?.workerStorageChoice).toMatchObject({
        expectedRevision: executor.releasedStorageRevision,
        kind: 'selected',
        storageRef: attached.storageRef,
      });
    } finally {
      if (!responseSettled) {
        const observations = await Promise.all(
          dispatchObservation.mock.results.flatMap((result, index) =>
            dispatchObservation.mock.calls[index]?.[0].coreDb === coreDb && result.type === 'return'
              ? [Promise.resolve(result.value)]
              : []
          )
        );
        console.info(
          'worker-environment-replacement-dispatch',
          JSON.stringify(
            observations.map((result) => ({
              startedTurns: result.startedTurns.map((started) => ({
                turnId: started.dispatch.entry.turnId,
                attemptId: started.dispatch.attempt.attemptId,
              })),
              terminalResult: result.terminalResult,
            }))
          )
        );
        console.info(
          'worker-environment-replacement-owners',
          JSON.stringify({
            admissions: coreDb.sqlite
              .prepare(
                'SELECT queue_entry_id, request_id, turn_id, status FROM scheduler_admission_entries'
              )
              .all(),
            attempts: coreDb.sqlite
              .prepare(
                'SELECT attempt_id, turn_id, phase, disposition, operation_id, terminal_cause, fence_ref FROM scheduler_execution_attempts'
              )
              .all(),
          })
        );
      }
      dispatchObservation.mockRestore();
      coreDb.sqlite.close();
    }
  });
});
