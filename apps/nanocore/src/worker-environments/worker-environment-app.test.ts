import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ActivateWorkerEnvironmentResponse,
  PrepareWorkerEnvironmentResponse,
} from '@openkit/app-api-schemas';
import { parse } from 'jsonc-parser';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from '../runtime/nanohost-session-dispatch.js';
import type { TurnCommandRuntimeContext, TurnStartRuntimeContext } from '../runtime/types.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  type WorkerStorageLayout,
} from '../runtime/worker-storage-bindings.js';
import {
  ensureConfiguredSchedulerBaseline,
  listSchedulerAdmissionEntriesForWorkspace,
  listSchedulerSessionLeasesForTurn,
  requireSchedulerSessionLease,
  upsertSchedulerCapacityRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
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

  /** Records each real scheduler dispatch before delegating to the existing simulator. */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    const isPredecessor = this.startedTurnIds.length === 0;
    this.startedTurnIds.push(turnId);
    await super.startTurn(store, turnId, input, context);
    if (isPredecessor) {
      const turn = store.getTurnById(turnId);
      if (!turn.agentSessionId) throw new Error('Started predecessor AgentSession is absent.');
      store.updateAgentSession(turn.agentSessionId, {
        status: 'busy',
        updatedAt: new Date().toISOString(),
      });
      store.updateTurn(turnId, {
        completedAt: null,
        humanGate: null,
        status: 'running',
      });
    }
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

  /** Emits the terminal interrupt and proves the old attachment cleanup before continuations run. */
  public async finishInterrupt(): Promise<void> {
    const pending = this.pendingInterrupt;
    const cleanup = this.residentCleanup;
    if (!pending || !cleanup) throw new Error('Resident interrupt fixture is incomplete.');
    this.fixtureCoreDb.sqlite
      .prepare(
        `UPDATE agent_session_runtime_bindings
         SET lifecycle_state = 'open', current_turn_id = NULL, current_lease_id = NULL,
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
    await super.interruptTurn(pending.store, pending.turnId, pending.context);
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
function createNanoHostDispatch(effect: ReturnType<typeof vi.fn>): NanoHostSessionDispatch {
  return {
    effect: effect as NanoHostSessionDispatch['effect'],
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
        defaultLogicalModelId: 'reasoning',
        enabled: true,
        logicalModels: [
          {
            contextManagement: [{ compactThreshold: 8_000, type: 'compaction' }],
            displayName: 'Reasoning',
            id: 'reasoning',
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

/** Configures one real local scheduler slot used by predecessor and successor Turns. */
function configureScheduler(coreDb: CoreDb): void {
  ensureConfiguredSchedulerBaseline(coreDb, { placement: 'local' });
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
    poolId: 'pool_local',
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 1,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: new Date().toISOString(),
    poolId: 'pool_local',
    queueDepth: 0,
    targetId: 'target_local',
  });
}

/** Links one disposable Git repository through the existing repository-resource route. */
async function linkRepository(
  app: ReturnType<typeof createApp>,
  headers: Readonly<Record<string, string>>,
  workspaceId: string
): Promise<void> {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-repository-'));
  execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
    cwd: repositoryPath,
  });
  execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
  writeFileSync(join(repositoryPath, 'README.md'), '# Worker environment replacement fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryPath, stdio: 'ignore' });
  const response = await app.request(`/api/app/workspaces/${workspaceId}/repositories/default`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Worker environment replacement fixture',
      localPath: repositoryPath,
    }),
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
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
         predecessor_fenced, ready, fresh_empty, observed_at, slot_count
       ) VALUES ('target_local', 'identity_local', 'deployment_local', 1, 1, 1, 1, ?, 1)`
    )
    .run(now);
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
         sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest,
         environment_class, max_open_sessions, max_harnesses, max_active_turns,
         lifecycle_state, health_state, drain_state, cleanup_state, created_at, updated_at
       ) VALUES (
         'sandbox_runtime_worker_environment', 'target_local', ?,
         'sandbox_integration_worker_environment', 'compatibility_worker_environment', ?,
         'worker', 8, 8, 1, 'open', 'ready', 'accepting', 'clean', ?, ?
       )`
    )
    .run(input.sandboxBindingRef, `sha256:${'f'.repeat(64)}`, now, now);
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
         current_turn_id, current_lease_id, next_turn_sequence, cleanup_state,
         created_at, updated_at
       ) VALUES (
         'binding_worker_environment', ?, ?, ?, ?, 'session_compatibility_worker_environment',
         1, 'ready', 'active', ?, ?, 1, 'clean', ?, ?
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
  it('prepares immutable candidates, activates the Agent CAS, and denies non-admin private entry', async () => {
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
        'administration'
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
      const initialAgentContent = readFileSync(agentPath, 'utf8');
      const initialRevision = contentRevision(initialAgentContent);
      const nanoHostEffect = vi.fn(async (request: NanoHostSessionEffectRequest) => {
        if (request.kind === 'image.acquire') return { digest: IMAGE_DIGEST };
        if (request.kind === 'image.inspect') return IMAGE_INSPECTION;
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      });
      const createResponses = vi.fn(async () => {
        throw new Error('Private administration provider dispatch must remain denied.');
      });
      const app = createApp({
        auth: noSessionAuth(),
        coreDb,
        dataRoot,
        llmGatewayDispatcher: { createResponses },
        mode: 'server',
        nanoHostSessionDispatch: createNanoHostDispatch(nanoHostEffect),
        store,
      });
      const adminHeaders = {
        authorization: `Bearer ${admin.secret}`,
        'content-type': 'application/json',
      };

      const preparedResponse = await app.request('/api/app/worker-environments/prepare', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          administrationThreadId: administrationThread.id,
          configuration: {
            expectedRevision: initialRevision,
            fileId: CONFIGURATION_FILE_ID,
          },
          declaration: DECLARATION,
          mode: 'prepare',
          replaceNow: null,
          requestId: '11111111-1111-4111-8111-111111111111',
          target: { agentId: AGENT_ID, kind: 'agent' },
        }),
      });
      const prepared = (await preparedResponse.json()) as PrepareWorkerEnvironmentResponse;

      expect(preparedResponse.status).toBe(200);
      expect(prepared).toMatchObject({
        affectedStorage: [],
        configuration: {
          expectedRevision: initialRevision,
          fileId: CONFIGURATION_FILE_ID,
        },
        image: IMAGE_INSPECTION,
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

      const activatedResponse = await app.request('/api/app/worker-environments/activate', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          affectedStorage: prepared.affectedStorage,
          configuration: prepared.configuration,
          confirmation: prepared.activationConfirmation,
          replaceNow: prepared.replaceNow,
          requestId: '22222222-2222-4222-8222-222222222222',
          resolvedCandidate: prepared.resolvedCandidate,
          target: prepared.target,
        }),
      });
      const activated = (await activatedResponse.json()) as ActivateWorkerEnvironmentResponse;
      const activatedAgentContent = readFileSync(agentPath, 'utf8');

      expect(activatedResponse.status).toBe(200);
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
      expect(activatedAgentContent).not.toBe(initialAgentContent);

      const denied = await app.request('/api/app/administration/conversation-turns', {
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
      });

      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      expect(createResponses).not.toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('waits for resident terminal cleanup before admitting a same-storage successor', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-replacement-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      insertCanonicalUser(coreDb);
      configureScheduler(coreDb);
      const store = createDemoStore({ dataRoot }, USER_ID);
      ensureUserQuickChatWorkspace({ coreDb, store, userId: USER_ID });
      const privateWorkspace = store.ensureQuickChatWorkspace(USER_ID);
      const administrationThread = store.createThread(
        privateWorkspace.id,
        'Administration',
        'thread_worker_environment_replacement',
        'administration'
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
        if (request.kind === 'image.inspect') return IMAGE_INSPECTION;
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      });
      const executor = new DeferredInterruptTurnExecutor(coreDb);
      const agentSetupOptions = {
        logicalModelId: 'reasoning',
        privateRoute: {
          providerModel: 'openai/gpt-5.2',
          providerProfileId: 'worker-environment-fixture',
        },
      } as const;
      const agentSetup = createTestAgentSetup(agentSetupOptions);
      const app = createApp({
        agentManifests: [agentSetup.manifest],
        auth: ownerSessionAuth(),
        coreDb,
        dataRoot,
        gatewayConfig: createTestGatewayConfig(agentSetupOptions),
        mode: 'server',
        nanoHostSessionDispatch: createNanoHostDispatch(nanoHostEffect),
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
      await linkRepository(app, sessionHeaders, productWorkspace.id);

      const predecessorResponse = await app.request('/api/turns', {
        method: 'POST',
        headers: { ...sessionHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          input: 'Keep the resident Worker active until replacement.',
          requestId: '44444444-4444-4444-8444-444444444444',
          threadId: productThread.id,
          workspaceId: productWorkspace.id,
        }),
      });
      const predecessor = (await predecessorResponse.json()) as {
        id: string;
        status: string;
      };
      expect(predecessorResponse.status).toBe(202);
      const storedPredecessor = store.getTurnById(predecessor.id);
      expect(storedPredecessor).toMatchObject({
        agentSessionId: expect.any(String),
        humanGate: null,
        status: 'running',
      });
      if (!storedPredecessor.agentSessionId) throw new Error('Predecessor AgentSession is absent.');
      const predecessorLease = listSchedulerSessionLeasesForTurn(coreDb, {
        threadId: productThread.id,
        turnId: predecessor.id,
        workspaceId: productWorkspace.id,
      })[0];
      if (!predecessorLease) throw new Error('Predecessor scheduler lease is absent.');
      const attached = attachResidentStorage({
        agentSessionId: storedPredecessor.agentSessionId,
        coreDb,
        leaseId: predecessorLease.leaseId,
        sandboxBindingRef: predecessorLease.sandboxBindingRef,
        threadId: productThread.id,
        turnId: predecessor.id,
        workspaceId: productWorkspace.id,
      });
      executor.setResidentCleanup({
        attachmentGeneration: attached.attachmentGeneration,
        expectedRevision: attached.revision,
        harnessInstanceId: attached.harnessInstanceId,
        sandboxBindingRef: predecessorLease.sandboxBindingRef,
        storageRef: attached.storageRef,
      });

      const preparedResponse = await app.request('/api/app/worker-environments/prepare', {
        method: 'POST',
        headers: { ...sessionHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          administrationThreadId: administrationThread.id,
          configuration: {
            expectedRevision: initialRevision,
            fileId: CONFIGURATION_FILE_ID,
          },
          declaration: DECLARATION,
          mode: 'prepare',
          replaceNow: {
            prompt: 'Continue with the resolved Worker image.',
            threadId: productThread.id,
            workspaceId: productWorkspace.id,
          },
          requestId: '55555555-5555-4555-8555-555555555555',
          target: { agentId: AGENT_ID, kind: 'agent' },
        }),
      });
      const prepared = (await preparedResponse.json()) as PrepareWorkerEnvironmentResponse;
      expect(preparedResponse.status).toBe(200);
      expect(prepared.affectedStorage).toEqual([
        { expectedRevision: attached.revision, storageRef: attached.storageRef },
      ]);

      const activationResponsePromise = app.request('/api/app/worker-environments/activate', {
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
      });
      await vi.waitFor(() => expect(executor.interruptCount).toBe(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const beforeTerminalTurnIds = store
        .listThreadTurns(productWorkspace.id, productThread.id)
        .map((turn) => turn.id);

      await executor.finishInterrupt();
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
      expect(store.getTurnById(predecessor.id).status).toBe('interrupted');
      if (!successor) throw new Error('Same-storage successor Turn is absent.');
      await vi.waitFor(() =>
        expect(store.getTurnById(successor.id)).toMatchObject({ status: 'awaiting_human' })
      );
      expect(executor.startedTurnIds).toEqual([predecessor.id, successor.id]);
      expect(requireSchedulerSessionLease(coreDb, predecessorLease.leaseId)).toMatchObject({
        releaseReason: 'turn-interrupted',
        status: 'released',
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
      coreDb.sqlite.close();
    }
  });
});
