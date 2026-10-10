import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import {
  ApiErrorSchema,
  ProductTurnSchema,
  TurnReadProjectionSchema,
  TurnSchema,
} from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AgentManifest } from './agents/manifest.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { createInMemoryRuntimeConfigSnapshot } from './config/runtime-config.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, type FsStore } from './lib/store.js';
import { ProviderRegistry } from './providers/registry.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  listSchedulerExecutionAttemptsForTurn,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  schedulerExecutionCorrelation,
} from './runtime/execution-attempt-records.js';
import { raiseRecordedPendingRequest } from './runtime/pending-request-flow.js';
import { startSchedulerDispatchRetryService } from './runtime/scheduler-dispatch-service.js';
import type {
  CommitPreparedAgentSessionForTurnInput,
  PrepareAgentSessionForTurnInput,
  PreparedAgentSessionForTurn,
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './runtime/types.js';
import * as schedulerOwners from './scheduler-records.js';
import type { CoreDb } from './storage/db.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const LOCAL_ACTOR = { kind: 'user', id: 'user_local' } as const;

/**
 * Returns the local provider registry that matches `createTestAgentSetup()`.
 *
 * @returns Registry containing the test OpenRouter profile.
 */
function testProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      displayName: 'Agent OpenRouter',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
    },
  ]);
}

/** Minimal turn executor that records route calls and applies deterministic turn transitions. */
class RecordingTurnExecutor implements TurnExecutor {
  public readonly capabilities: TurnExecutor['capabilities'];
  public readonly eventFamilies: TurnExecutor['eventFamilies'] = [];
  public interruptCalls = 0;
  public startCalls = 0;
  protected readonly completeStarts: boolean;
  public coreDb?: CoreDb;
  public executionBackend?: SimulatedTurnExecutor;

  /**
   * Creates a route-level executor with explicit start and interrupt behavior.
   *
   * @param options Whether starts complete synchronously and interrupts are supported.
   */
  public constructor(
    options: { readonly completeStarts?: boolean; readonly interrupts?: boolean } = {}
  ) {
    this.capabilities = {
      approvals: false,
      artifacts: false,
      interrupts: options.interrupts ?? true,
      questions: false,
      workspaceConfig: true,
      workspaceKnowledgeEditing: false,
    };
    this.completeStarts = options.completeStarts ?? true;
  }

  /**
   * Admits one fresh AgentSession for a Thread that has no current runtime owner.
   *
   * @param _store Store inspected by runtime-owned executors; unused for this fresh fixture.
   * @param input Static AEP inputs for the future Turn.
   * @returns Fresh AgentSession identity and compatibility key.
   */
  public async prepareAgentSessionForTurn(
    _store: FsStore,
    input: PrepareAgentSessionForTurnInput
  ): Promise<PreparedAgentSessionForTurn> {
    if (!this.executionBackend)
      throw new Error('Recording fixture has no configured Core backend.');
    return this.executionBackend.prepareAgentSessionForTurn(_store, input);
  }

  /**
   * No-op post-dispatch commit for this recording executor, which never replaces a predecessor.
   *
   * @param _store Store mutated by replacement commits; unused here.
   * @param _input Prepared decision retained after lease acquisition.
   */
  public async commitPreparedAgentSessionForTurn(
    _store: FsStore,
    _input: CommitPreparedAgentSessionForTurnInput
  ): Promise<void> {
    if (!this.executionBackend)
      throw new Error('Recording fixture has no configured Core backend.');
    await this.executionBackend.commitPreparedAgentSessionForTurn(_store, _input);
  }

  /**
   * Records one start and optionally completes the created turn synchronously.
   *
   * @param store Store that owns the turn.
   * @param turnId Turn selected by the scheduler.
   * @param _input User input accepted for the turn.
   * @param _context Scheduler-owned runtime context.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    _input: string,
    _context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.startCalls += 1;
    await this.beginModeledTurn(store, turnId, _context);
    if (this.completeStarts) {
      this.publishCompletedTurn(store, turnId, _context);
      await this.releaseModeledTurn(store, turnId);
    }
  }

  /** Records the modeled original submission under actual prepared Core authority. */
  protected async beginModeledTurn(
    store: FsStore,
    turnId: string,
    context: TurnStartRuntimeContext
  ): Promise<void> {
    if (!this.coreDb || !this.executionBackend || !context.attemptId || !context.agentSessionId)
      throw new Error('Modeled Turn has no exact Core preparation.');
    const turn = store.getTurnById(turnId);
    const timestamp = new Date().toISOString();
    store.createAgentSession({
      id: context.agentSessionId,
      agentId: turn.agentId!,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      status: 'busy',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const attempt = recordSchedulerExecutionOperation(this.coreDb, {
      attemptId: context.attemptId,
      operationId: `recording:${turnId}`,
      submission: true,
    });
    acceptSchedulerExecutionObservation(
      this.coreDb,
      await this.executionBackend.submit({
        ...schedulerExecutionCorrelation(attempt),
        deadline: attempt.deadline!,
      })
    );
    context.onSubmissionSettled?.();
  }

  /** Publishes terminal product state while retaining execution until the fixture's closeout gate. */
  protected publishCompletedTurn(
    store: FsStore,
    turnId: string,
    context: TurnStartRuntimeContext
  ): void {
    const turn = store.updateTurn(turnId, {
      completedAt: new Date().toISOString(),
      status: 'completed',
    });
    markSchedulerExecutionAttemptClosing(this.coreDb!, {
      attemptId: context.attemptId!,
      cause: 'turn-completed',
      outcomeRef: `turn:${turnId}:completed`,
    });
    store.emitTurnEvent(
      turnId,
      {
        event: 'turn.completed',
        requestId: context.requestId,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId,
        data: { type: 'turn-completed', stopReason: 'completed', turn },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
  }

  /** Releases only this modeled executor's complete barriers; it owns no Native output or physical resident. */
  protected async releaseModeledTurn(store: FsStore, turnId: string): Promise<void> {
    const turn = store.getTurnById(turnId);
    for (const attempt of listSchedulerExecutionAttemptsForTurn(this.coreDb!, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId,
    })) {
      if (attempt.phase === 'closed') continue;
      const closing = markSchedulerExecutionAttemptClosing(this.coreDb!, {
        attemptId: attempt.attemptId,
        cause: `turn-${turn.status}`,
        outcomeRef: `turn:${turnId}:${turn.status}`,
      });
      const proof = {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      } as const;
      const correlation = schedulerExecutionCorrelation(closing);
      const released = await this.executionBackend!.release({ ...correlation, proof });
      closeSchedulerExecutionAttemptWithFence(this.coreDb!, {
        correlation,
        proof,
        fenceRef: released.fenceRef!,
      });
    }
  }

  /**
   * Records one interrupt and marks the selected turn interrupted.
   *
   * @param store Store that owns the turn.
   * @param turnId Turn selected by the route.
   * @param _context Request correlation context.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    _context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    this.interruptCalls += 1;
    store.updateTurn(turnId, {
      completedAt: new Date().toISOString(),
      status: 'interrupted',
    });
    if (this.coreDb) await this.releaseModeledTurn(store, turnId);
  }
}

/**
 * Keeps executor completion unresolved so admission can be observed independently.
 */
class HoldingTurnExecutor extends RecordingTurnExecutor {
  /** Signals actual executor entry, separately from command admission refusal. */
  public readonly launched = Promise.withResolvers<void>();
  /** Test-owned release of worker terminal publication. */
  public readonly completion = Promise.withResolvers<void>();
  /** Signals stored terminal status while executor cleanup is still held. */
  public readonly terminalPublished = Promise.withResolvers<void>();
  /** Test-owned release of executor cleanup after terminal publication. */
  public readonly cleanup = Promise.withResolvers<void>();
  /** Signals executor settlement, including controlled failure. */
  public readonly finished = Promise.withResolvers<void>();
  /** Whether the held executor has actually settled. */
  public completionObserved = false;

  /** @param fail Whether the admitted worker fails after release. */
  public constructor(private readonly fail: boolean) {
    super();
  }

  /**
   * Holds completion, then publishes a terminal Turn or a controlled startup failure.
   *
   * @param store Store that owns the admitted Turn.
   * @param turnId Exact scheduler-selected Turn.
   * @param _input Admitted worker input; the held-response fixture does not consume it.
   * @param context Existing scheduler runtime context.
   */
  public override async startTurn(
    store: FsStore,
    turnId: string,
    _input: string,
    context: TurnStartRuntimeContext = { requestId: null, workspaceRoots: [] }
  ): Promise<void> {
    this.startCalls += 1;
    await this.beginModeledTurn(store, turnId, context);
    this.launched.resolve();
    try {
      await this.completion.promise;
      if (this.fail) {
        store.updateTurn(turnId, {
          completedAt: new Date().toISOString(),
          status: 'failed',
          error: { code: 'worker_start_failed', message: 'Controlled admitted failure.' },
        });
        throw new Error('Controlled admitted failure.');
      }
      // The recording fixture has no backend cleanup or evidence to materialize.
      this.publishCompletedTurn(store, turnId, context);
      this.terminalPublished.resolve();
      await this.cleanup.promise;
      await this.releaseModeledTurn(store, turnId);
    } finally {
      this.completionObserved = true;
      this.finished.resolve();
    }
  }
}

/**
 * Creates a scheduler-backed app with an admitted Agent configuration.
 *
 * @param executor Turn executor installed in the app.
 * @param slug Stable temporary-directory label.
 * @param workerPlacement Configured scheduler placement.
 * @param manifest Exact authored Agent configuration admitted by the app.
 * @param persist Whether to use real Workspace SQLite for durable receipt observations.
 * @returns App, product store and Core database fixture.
 */
async function createSchedulerFixture(
  executor: RecordingTurnExecutor,
  slug: string,
  workerPlacement: 'local' | 'remote' = 'local',
  manifest: AgentManifest = createTestAgentSetup().manifest,
  persist = false
) {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-turn-routes-${slug}-`));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = createDemoStore({ dataRoot, ...(persist ? { coreDb } : {}) });
  executor.coreDb = coreDb;
  executor.executionBackend = new SimulatedTurnExecutor({ coreDb });
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });
  const app = createApp({
    agentManifests: [manifest],
    coreDb,
    providerRegistry: testProviderRegistry(),
    store,
    turnExecutor: executor,
    workerPlacement,
  });
  return { app, coreDb, dataRoot, store };
}

/** Creates session authentication from one test-only user header. */
function createHeaderAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async ({ headers }) => {
        const userId = headers.get('x-user-id');
        return userId ? { session: { id: `session_${userId}` }, user: { id: userId } } : null;
      },
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

/** Creates a server-mode scheduler fixture with an owner and an editor in one Workspace. */
async function createSharedSchedulerFixture(executor: RecordingTurnExecutor, slug: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-turn-routes-shared-${slug}-`));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, created_at, updated_at, kind
      ) VALUES ('user_other', 'Other User', 'other@example.com', false, ?, ?, 'human')`
    )
    .run(now, now);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES ('ws_demo', 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(timestamp, timestamp, timestamp);

  const store = createDemoStore({ dataRoot, coreDb });
  executor.coreDb = coreDb;
  executor.executionBackend = new SimulatedTurnExecutor({ coreDb });
  const app = createApp({
    agentManifests: [createTestAgentSetup().manifest],
    auth: createHeaderAuthStub(),
    coreDb,
    mode: 'server',
    providerRegistry: testProviderRegistry(),
    store,
    turnExecutor: executor,
  });
  return { app, coreDb, dataRoot, store };
}

/**
 * Observes the latest execution attempt for one product Turn.
 *
 * @param coreDb Open Core database.
 * @param turnId Product turn id.
 * @returns Stored attempt phase, when present.
 */
function readTurnAttempt(coreDb: CoreDb, turnId: string) {
  const exists = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return exists
    ? (coreDb.sqlite
        .prepare(
          'SELECT phase FROM scheduler_execution_attempts WHERE turn_id = ? ORDER BY rowid DESC LIMIT 1'
        )
        .get(turnId) as { readonly phase: string } | undefined)
    : undefined;
}

/**
 * Reproduces the scheduler-owned deterministic turn id for failed-start orphan checks.
 *
 * @param canonicalActorRef Canonical serialized trigger ActorRef.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Turn-start request id.
 * @returns Scheduler-owned turn id.
 */
function schedulerTurnId(
  canonicalActorRef: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  const suffix = createHash('sha256')
    .update(`${canonicalActorRef}:${workspaceId}:${threadId}:${requestId}`)
    .digest('hex')
    .slice(0, 16);

  return `turn_${requestId}_${suffix}`;
}

describe('generic turn routes', () => {
  it('starts and completes work with an explicit empty Agent input list', async () => {
    const executor = new RecordingTurnExecutor();
    const manifest = { ...createTestAgentSetup().manifest, workspace: { inputs: [] } };
    const fixture = await createSchedulerFixture(executor, 'empty-input', 'local', manifest);
    try {
      const response = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              agentId: manifest.id,
              input: 'Organize the supplied context',
              requestId: '00000000-0000-4000-8000-000000000399',
            }),
          }
        )
      );
      expect(response.status).toBe(202);
      const turn = TurnSchema.parse(await response.json());
      await vi.waitFor(() => expect(executor.startCalls).toBe(1));
      await vi.waitFor(() =>
        expect(fixture.store.getTurn('ws_demo', 'th_demo', turn.id).status).toBe('completed')
      );
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });
  it('reads one turn through its owning workspace and thread path', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Read this turn', LOCAL_ACTOR);
    const app = createApp({ store, turnExecutor: new RecordingTurnExecutor() });

    const response = await app.request('/api/app/operations/turn.read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws_demo', threadId: 'th_demo', turnId: turn.id }),
    });

    expect(response.status).toBe(200);
    expect(TurnReadProjectionSchema.parse(await response.json())).toEqual({
      ...turn,
      contextPackageDigest: null,
    });
  });

  it('omits AgentSession identity from ordinary turn reads while the durable Turn retains it', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Hide AgentSession identity', LOCAL_ACTOR);
    store.updateTurn(turn.id, { agentSessionId: 'as_hidden' });
    const app = createApp({ store, turnExecutor: new RecordingTurnExecutor() });

    const response = await app.request('/api/app/operations/turn.read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws_demo', threadId: 'th_demo', turnId: turn.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('agentSessionId');
    expect(store.getTurn('ws_demo', 'th_demo', turn.id).agentSessionId).toBe('as_hidden');
  });

  it('does not read a turn through a different workspace or thread path', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Keep this turn scoped', LOCAL_ACTOR);
    const app = createApp({ store, turnExecutor: new RecordingTurnExecutor() });

    for (const path of [
      `/api/workspaces/ws_quick_chat/threads/th_demo/turns/${turn.id}`,
      `/api/workspaces/ws_demo/threads/th_missing/turns/${turn.id}`,
    ]) {
      const [, , , workspaceId, , threadId, , turnId] = path.split('/');
      const response = await app.request('/api/app/operations/turn.read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, threadId, turnId }),
      });

      expect(response.status).toBe(404);
      expect(ApiErrorSchema.parse(await response.json()).code).toBe('not_found');
    }
  });

  it('rejects an interrupt scope mismatch before executor or store mutation', async () => {
    const store = createDemoStore();
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Do not interrupt across scopes',
      LOCAL_ACTOR
    );
    const executor = new RecordingTurnExecutor();
    const app = createApp({ store, turnExecutor: executor });

    const response = await app.request(
      ...operationRequest(
        'turn.interrupt',
        { workspaceId: 'ws_demo', threadId: 'th_missing', turnId: turn.id },
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000306',
            threadId: turn.threadId,
            turnId: turn.id,
            workspaceId: turn.workspaceId,
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const payload = (await response.json()) as { readonly code?: string };

    expect({
      commandRecords: store.listCommandRequests().length,
      executorCalls: executor.interruptCalls,
      responseCode: payload.code,
      responseStatus: response.status,
      turnStatus: store.getTurn(turn.workspaceId, turn.threadId, turn.id).status,
    }).toEqual({
      commandRecords: 0,
      executorCalls: 0,
      responseCode: 'not_found',
      responseStatus: 404,
      turnStatus: 'running',
    });
  });

  it('returns typed unsupported without mutating when the executor cannot interrupt', async () => {
    const executor = new RecordingTurnExecutor({ interrupts: false, completeStarts: false });
    const { app, store, coreDb } = await createSchedulerFixture(executor, 'unsupported-interrupt');
    try {
      const start = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              agentId: 'agent_codex_host',
              input: 'Unsupported interrupt',
              requestId: '00000000-0000-4000-8000-000000000308',
            }),
          }
        )
      );
      expect(start.status).toBe(202);
      const turn = TurnSchema.parse(await start.json());
      await vi.waitFor(() => expect(executor.startCalls).toBe(1));
      await setImmediate();
      const before = store.listCommandRequests();

      const response = await app.request(
        ...operationRequest(
          'turn.interrupt',
          { workspaceId: 'ws_demo', threadId: 'th_demo', turnId: turn.id },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000307',
              threadId: turn.threadId,
              turnId: turn.id,
              workspaceId: turn.workspaceId,
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const payload = (await response.json()) as { readonly code?: string };

      expect({
        commandRecords: store.listCommandRequests().length,
        executorCalls: executor.interruptCalls,
        responseCode: payload.code,
        responseStatus: response.status,
        turnStatus: store.getTurn(turn.workspaceId, turn.threadId, turn.id).status,
      }).toEqual({
        commandRecords: before.length,
        executorCalls: 0,
        responseCode: 'interrupts_not_supported',
        responseStatus: 501,
        turnStatus: 'running',
      });
      expect(store.listCommandRequests()).toEqual(before);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not rewrite a terminal turn through a new interrupt command', async () => {
    const store = createDemoStore();
    const created = store.createTurn('ws_demo', 'th_demo', 'Already complete', LOCAL_ACTOR);
    const turn = store.updateTurn(created.id, {
      completedAt: '2026-07-12T00:00:00.000Z',
      status: 'completed',
    });
    const executor = new RecordingTurnExecutor();
    const app = createApp({ store, turnExecutor: executor });

    const response = await app.request(
      ...operationRequest(
        'turn.interrupt',
        { workspaceId: 'ws_demo', threadId: 'th_demo', turnId: turn.id },
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000308',
            threadId: turn.threadId,
            turnId: turn.id,
            workspaceId: turn.workspaceId,
          }),
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const payload = (await response.json()) as { readonly code?: string };
    const storedTurn = store.getTurn(turn.workspaceId, turn.threadId, turn.id);

    expect({
      commandRecords: store.listCommandRequests().length,
      completedAtUnchanged: storedTurn.completedAt === turn.completedAt,
      executorCalls: executor.interruptCalls,
      responseCode: payload.code,
      responseStatus: response.status,
      turnStatus: storedTurn.status,
    }).toEqual({
      commandRecords: 0,
      completedAtUnchanged: true,
      executorCalls: 0,
      responseCode: 'turn_not_interruptible',
      responseStatus: 409,
      turnStatus: 'completed',
    });
  });

  it('rejects a UserInput Gate response from a different Workspace editor', async () => {
    const executor = new RecordingTurnExecutor({ completeStarts: false });
    const fixture = await createSharedSchedulerFixture(executor, 'responsible-user');
    const startRequestId = '00000000-0000-4000-8000-000000000410';

    try {
      const startResponse = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              agentId: 'agent_codex_host',
              input: 'Pause for the responsible user.',
              requestId: startRequestId,
              threadId: 'th_demo',
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json', 'x-user-id': 'user_local' },
          }
        )
      );
      expect(startResponse.status, await startResponse.clone().text()).toBe(202);
      const turn = TurnSchema.parse(await startResponse.json());
      await vi.waitFor(() => expect(executor.startCalls).toBe(1));
      await setImmediate();
      const acceptedAt = turn.startedAt ?? new Date().toISOString();
      const requestItem = fixture.store.createItem({
        id: `it_responsible_user_${turn.id}`,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'user-input-request',
        status: 'completed',
        responsibleUserId: 'user_local',
        userInputRequestId: `ui_responsible_user_${turn.id}`,
        prompt: 'Only the responsible user may answer.',
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Continue?',
            options: null,
            isOther: false,
            isSecret: false,
          },
        ],
        createdAt: acceptedAt,
        completedAt: acceptedAt,
      });
      const workspaceDb = openWorkspaceDb(fixture.dataRoot, 'ws_demo');
      try {
        applyScopedMigrations(workspaceDb);
        raiseRecordedPendingRequest(fixture.store, workspaceDb.sqlite, {
          requestId: requestItem.userInputRequestId,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          raisingTurnId: turn.id,
          requestItemId: requestItem.id,
          kind: 'user-input',
          requesterKind: 'assistant',
          responsibleUserId: 'user_local',
          questions: requestItem.type === 'user-input-request' ? requestItem.questions : [],
          questionDigest: 'digest-responsible-user',
          now: acceptedAt,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      const response = await fixture.app.request(
        ...operationRequest(
          'question.answer',
          { userInputRequestId: requestItem.userInputRequestId },
          {
            method: 'POST',
            body: JSON.stringify({
              answers: { choice: ['Continue'] },
              requestId: '00000000-0000-4000-8000-000000000411',
              threadId: 'th_demo',
              userInputRequestId: requestItem.userInputRequestId,
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json', 'x-user-id': 'user_other' },
          }
        )
      );

      expect(response.status, await response.clone().text()).toBe(403);
      expect(ApiErrorSchema.parse(await response.json()).code).toBe('workspace_access_denied');
      expect(fixture.store.getTurn('ws_demo', 'th_demo', turn.id).status).toBe('running');
      expect(
        fixture.store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.type === 'user-input-response')
      ).toEqual([]);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    'manifest',
    'shim',
    'environment',
    'configuration',
    'transient',
  ] as const)('preserves pre-acceptance validation and fails an accepted Turn in place after preparation refusal: %s', async (failure) => {
    const executor = new RecordingTurnExecutor();
    const manifest = createTestAgentSetup().manifest;
    if (failure === 'manifest' || failure === 'shim') {
      const missingPath =
        failure === 'manifest' ? '/usr/local/bin/node' : '/usr/local/bin/openkit-worker-shim';
      manifest.runtime.binaries = manifest.runtime.binaries.filter(
        (binary) => binary.path !== missingPath
      );
    } else if (failure === 'environment') {
      manifest.runtime.environment = { OPENKIT_AGENT_PACKAGE: 'authored-conflict' };
    } else if (failure === 'configuration') {
      manifest.requiredFeatures = ['unsupported.preparation.feature'];
      // A recoverable catalog gap cannot make an independent input-bound refusal retryable.
      manifest.models.preferredLogicalModelId = 'unavailable-model';
    }
    const prepare = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    if (failure === 'transient') {
      // Identical text is not evidence of deterministic manifest resolution failure.
      prepare.mockRejectedValue(
        new Error('Agent manifest does not declare required control binary: /usr/local/bin/node')
      );
    }
    const fixture = await createSchedulerFixture(
      executor,
      `preparation-${failure}`,
      'local',
      manifest
    );
    const requestId = '00000000-0000-4000-8000-000000000399';
    try {
      const response = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              agentId: manifest.id,
              input: 'Prepare this admitted Agent',
              requestId,
              threadId: 'th_demo',
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const preAcceptance = failure === 'configuration';
      if (preAcceptance) {
        expect(ApiErrorSchema.parse(await response.json()).code).toBe('agent_not_ready');
      } else {
        expect(response.status).toBe(202);
        const accepted = TurnSchema.parse(await response.json());
        expect(accepted.id).toBe(
          schedulerTurnId(JSON.stringify(LOCAL_ACTOR), 'ws_demo', 'th_demo', requestId)
        );
        await vi.waitFor(() =>
          expect(readTurnAttempt(fixture.coreDb, accepted.id)?.phase).toBe('closed')
        );
        expect(fixture.store.getTurnById(accepted.id)).toMatchObject({
          status: 'failed',
          error: { code: 'worker_preparation_failed', message: expect.any(String) },
        });
        expect(
          fixture.coreDb.sqlite
            .prepare(
              'SELECT disposition, operation_id FROM scheduler_execution_attempts WHERE turn_id = ?'
            )
            .get(accepted.id)
        ).toEqual({ disposition: 'not_accepted', operation_id: null });
        expect(
          fixture.store.getCommandRequest('turn.start', requestId, {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
          })
        ).toMatchObject({ response: { kind: 'turn', id: accepted.id } });
      }
      const readAdmission = () =>
        fixture.coreDb.sqlite
          .prepare(
            'SELECT queue_entry_id AS queueEntryId, status FROM scheduler_admission_entries WHERE request_id = ?'
          )
          .all(requestId);
      const admissions = readAdmission();
      expect(admissions).toEqual(
        preAcceptance
          ? []
          : [
              {
                queueEntryId: schedulerTurnId(
                  JSON.stringify(LOCAL_ACTOR),
                  'ws_demo',
                  'th_demo',
                  requestId
                ).replace(/^turn_/, 'queue_'),
                status: 'admitted',
              },
            ]
      );
      if (preAcceptance) {
        expect(
          fixture.coreDb.sqlite.prepare('SELECT attempt_id FROM scheduler_execution_attempts').all()
        ).toEqual([]);
        expect(fixture.store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
        expect(fixture.store.listCommandRequests()).toEqual([]);
      }
      expect(prepare).toHaveBeenCalledTimes(failure === 'configuration' ? 0 : 1);
      expect(executor.startCalls).toBe(0);
      const snapshot = createInMemoryRuntimeConfigSnapshot({
        agentManifests: [manifest],
        dataRoot: fixture.coreDb.dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: testProviderRegistry(),
      });
      const service = startSchedulerDispatchRetryService({
        coreDb: fixture.coreDb,
        store: fixture.store,
        turnExecutor: executor,
        executionBackend: executor.executionBackend!,
        runtimeConfigSnapshot: () => snapshot,
        intervalMs: 30_000,
        setInterval: () => null,
        clearInterval: () => {},
      });
      try {
        const result = await service.runOnce();
        expect(result?.terminalResult).toEqual({ status: 'queued', reason: 'no-queued-entry' });
        expect(prepare).toHaveBeenCalledTimes(failure === 'configuration' ? 0 : 1);
        expect(readAdmission()).toEqual(admissions);
        expect(executor.startCalls).toBe(0);
      } finally {
        service.stop();
      }
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('closes the execution attempt when a new Turn completes synchronously', async () => {
    const executor = new RecordingTurnExecutor();
    const fixture = await createSchedulerFixture(executor, 'completed-lease');

    try {
      const response = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              agentId: 'agent_codex_host',
              input: 'Complete synchronously',
              requestId: '00000000-0000-4000-8000-000000000301',
              threadId: 'th_demo',
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const turn = TurnSchema.parse(await response.json());

      expect(response.status).toBe(202);
      expect(turn.status).toBe('pending');
      await vi.waitFor(() =>
        expect(readTurnAttempt(fixture.coreDb, turn.id)?.phase).toBe('closed')
      );
      expect(fixture.store.getTurnById(turn.id).status).toBe('completed');
      expect(readTurnAttempt(fixture.coreDb, turn.id)).toEqual({
        phase: 'closed',
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('acknowledges and launches a product Turn in a remote deployment', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-06T00:00:00.000Z'));
    const executor = new RecordingTurnExecutor();
    const fixture = await createSchedulerFixture(executor, 'remote-placement', 'remote');

    try {
      const response = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              agentId: 'agent_codex_host',
              input: 'Run on the remote target',
              requestId: '00000000-0000-4000-8000-000000000309',
              threadId: 'th_demo',
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      expect(response.status).toBe(202);
      const turn = TurnSchema.parse(await response.json());
      await vi.waitFor(() => expect(executor.startCalls).toBe(1));
      // This adapter observation is transitional storage, not a generic Core grant or schema requirement.
      // Observe the acquired NanoHost liveness profile, separately from the absolute Core deadline.
      const nativeLiveness = fixture.coreDb.sqlite
        .prepare(`SELECT created_at, startup_deadline,
        heartbeat_deadline, heartbeat_timeout_ms FROM scheduler_execution_attempts WHERE turn_id = ?`)
        .get(turn.id) as
        | {
            created_at: string;
            startup_deadline: string;
            heartbeat_deadline: string | null;
            heartbeat_timeout_ms: number;
          }
        | undefined;
      expect(nativeLiveness).toBeDefined();
      expect(
        Date.parse(nativeLiveness!.startup_deadline) - Date.parse(nativeLiveness!.created_at)
      ).toBe(1_500_000);
      // The Native heartbeat budget begins at an accepted heartbeat; startup owns the pre-heartbeat gate.
      expect(nativeLiveness!.heartbeat_deadline).toBeNull();
      expect(nativeLiveness!.heartbeat_timeout_ms).toBe(30_000);
    } finally {
      await vi.waitFor(() =>
        expect(
          readTurnAttempt(
            fixture.coreDb,
            fixture.store.listThreadTurns('ws_demo', 'th_demo')[0]!.id
          )?.phase
        ).toBe('closed')
      );
      fixture.coreDb.sqlite.close();
      vi.useRealTimers();
    }
  });

  it('closes the execution attempt after a supported interrupt', async () => {
    const executor = new RecordingTurnExecutor({ completeStarts: false });
    const fixture = await createSchedulerFixture(executor, 'interrupt-lease');

    try {
      const startResponse = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              agentId: 'agent_codex_host',
              input: 'Keep running until interrupted',
              requestId: '00000000-0000-4000-8000-000000000302',
              threadId: 'th_demo',
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const startedTurn = TurnSchema.parse(await startResponse.json());
      await vi.waitFor(() => expect(executor.startCalls).toBe(1));
      await setImmediate();
      const interruptResponse = await fixture.app.request(
        ...operationRequest(
          'turn.interrupt',
          { workspaceId: 'ws_demo', threadId: 'th_demo', turnId: startedTurn.id },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000303',
              threadId: 'th_demo',
              turnId: startedTurn.id,
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const interruptedTurn = TurnSchema.parse(await interruptResponse.json());

      expect({
        interruptCalls: executor.interruptCalls,
        interruptStatus: interruptResponse.status,
        attempt: readTurnAttempt(fixture.coreDb, startedTurn.id),
        startStatus: startResponse.status,
        turnStatus: interruptedTurn.status,
      }).toEqual({
        interruptCalls: 1,
        interruptStatus: 200,
        attempt: { phase: 'closed' },
        startStatus: 202,
        turnStatus: 'interrupted',
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('replays a successful turn start before revalidating mutable Agent configuration', async () => {
    const executor = new RecordingTurnExecutor();
    const manifest = createTestAgentSetup().manifest;
    const fixture = await createSchedulerFixture(
      executor,
      'configuration-replay',
      'local',
      manifest
    );
    const body = {
      agentId: 'agent_codex_host',
      input: 'Replay this completed turn',
      requestId: '00000000-0000-4000-8000-000000000304',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    };

    try {
      const firstResponse = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const firstTurn = TurnSchema.parse(await firstResponse.json());
      await vi.waitFor(() =>
        expect(readTurnAttempt(fixture.coreDb, firstTurn.id)?.phase).toBe('closed')
      );
      manifest.requiredFeatures = ['unsupported.replay.feature'];

      const replayResponse = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const replayPayload = (await replayResponse.json()) as { readonly id?: string };

      expect({
        executorStarts: executor.startCalls,
        firstStatus: firstResponse.status,
        replayedTurnId: replayPayload.id,
        replayStatus: replayResponse.status,
      }).toEqual({
        executorStarts: 1,
        firstStatus: 202,
        replayedTurnId: firstTurn.id,
        replayStatus: 202,
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('starts and replays a direct turn under one presented cross-Workspace admin token', async () => {
    const executor = new RecordingTurnExecutor();
    const fixture = await createSharedSchedulerFixture(executor, 'admin-direct-turn');
    const now = Date.now();
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status
        ) VALUES ('user_admin_nomember', 'Admin', 'admin-nomember@example.com', false, ?, ?, 'human', 'active')`
      )
      .run(now, now);
    const issued = createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_admin_nomember',
      scope: 'server-admin',
      tokenId: 'token_admin_direct_turn',
      workspaceIds: [],
    });
    const body = {
      agentId: 'agent_codex_host',
      input: 'Run the directly requested task.',
      requestId: '00000000-0000-4000-8000-000000000304',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    };
    const request = () =>
      fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify(body),
            headers: {
              authorization: `Bearer ${issued.secret}`,
              'content-type': 'application/json',
            },
          }
        )
      );

    try {
      const first = await request();
      expect(first.status, await first.clone().text()).toBe(202);
      const turn = TurnSchema.parse(await first.json());
      expect(
        fixture.coreDb.sqlite
          .prepare(
            `SELECT server_admin_token_id AS tokenId, trigger_actor_json AS triggerActorJson
             FROM scheduler_admission_entries WHERE turn_id = ?`
          )
          .get(turn.id)
      ).toEqual({
        tokenId: issued.tokenId,
        triggerActorJson: JSON.stringify({ kind: 'user', id: 'user_admin_nomember' }),
      });
      await vi.waitFor(() =>
        expect(readTurnAttempt(fixture.coreDb, turn.id)?.phase).toBe('closed')
      );
      const replay = await request();
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(TurnSchema.parse(await replay.json()).id).toBe(turn.id);
      expect(executor.startCalls).toBe(1);
      expect(
        fixture.coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries WHERE turn_id = ?')
          .get(turn.id)
      ).toEqual({ count: 1 });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('rejects an invalid thread before scheduler, store, or source-context side effects', async () => {
    const executor = new RecordingTurnExecutor({ completeStarts: false });
    const fixture = await createSchedulerFixture(executor, 'invalid-thread');
    const requestId = '00000000-0000-4000-8000-000000000305';
    const threadId = 'th_missing';
    const turnId = schedulerTurnId(
      JSON.stringify({ kind: 'user', id: 'user_local' }),
      'ws_demo',
      threadId,
      requestId
    );
    const sourceCatalogPath = join(
      fixture.coreDb.dataRoot,
      'workspaces',
      'ws_demo',
      'config',
      'data-sources.jsonc'
    );
    rmSync(sourceCatalogPath, { force: true });

    try {
      const response = await fixture.app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              agentId: 'agent_codex_host',
              input: 'Do not admit an invalid thread',
              requestId,
              threadId,
              workspaceId: 'ws_demo',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const payload = (await response.json()) as { readonly code?: string };
      const admissionCount = (
        fixture.coreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries WHERE request_id = ?')
          .get(requestId) as { readonly count: number }
      ).count;
      let orphanTurnExists = true;
      try {
        fixture.store.getTurnById(turnId);
      } catch {
        orphanTurnExists = false;
      }

      expect({
        attemptCount: readTurnAttempt(fixture.coreDb, turnId) ? 1 : 0,
        admissionCount,
        commandRecords: fixture.store.listCommandRequests().length,
        executorStarts: executor.startCalls,
        orphanTurnExists,
        responseCode: payload.code,
        responseStatus: response.status,
        sourceCatalogExists: existsSync(sourceCatalogPath),
      }).toEqual({
        attemptCount: 0,
        admissionCount: 0,
        commandRecords: 0,
        executorStarts: 0,
        orphanTurnExists: false,
        responseCode: 'not_found',
        responseStatus: 404,
        sourceCatalogExists: false,
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });
});

// Simulated continuity receives fixture-owned confirmed image evidence before metadata resolution.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

describe('Core Turn durable admission response', () => {
  it.each([
    'http',
    'remote-mcp',
    'failure',
  ] as const)('returns %s admission and receipt before worker completion', async (entry) => {
    const executor = new HoldingTurnExecutor(entry === 'failure');
    const { app, coreDb, dataRoot, store } = await createSchedulerFixture(
      executor,
      entry,
      'local',
      createTestAgentSetup().manifest,
      true
    );
    const requestId = '00000000-0000-4000-8000-000000000991';
    const scope = { workspaceId: 'ws_demo', threadId: 'th_demo' };
    const input = {
      ...scope,
      agentId: 'agent_codex_host',
      input: 'Run a bounded worker.',
      requestId,
    };
    const token =
      entry === 'remote-mcp'
        ? createOpenKitAccessTokenRecord(coreDb, {
            ownerUserId: 'user_local',
            scope: 'workspace',
            workspaceIds: ['ws_demo'],
            expiresAt: '2099-01-01T00:00:00.000Z',
          })
        : null;
    /** Invokes the actual HTTP or MCP call binding. */
    const submit = (text = input.input) =>
      token
        ? app.request('http://127.0.0.1/mcp', {
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
                name: 'call',
                arguments: { operation: 'turn.start', input: { ...input, input: text } },
              },
            }),
          })
        : app.request('/api/app/operations/turn.start', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
            body: JSON.stringify({ ...input, input: text }),
          });
    let responseObserved = false;
    let receiptAtResponse: undefined | ReturnType<FsStore['getCommandRequest']>;
    const pending = Promise.resolve(submit()).then((response) => {
      receiptAtResponse = store.getCommandRequest('turn.start', requestId, scope);
      responseObserved = true;
      return response;
    });
    try {
      await vi.waitFor(() => expect(responseObserved).toBe(true));
      expect(executor.completionObserved).toBe(false);
      const response = await pending;
      expect(response.status).toBe(token ? 200 : 202);
      const wire = await response.json();
      if (token) expect(wire.result.isError).not.toBe(true);
      const turn = ProductTurnSchema.parse(token ? JSON.parse(wire.result.content[0].text) : wire);
      expect(['pending', 'running']).toContain(turn.status);
      expect(turn.completedAt).toBeNull();
      const receipt = receiptAtResponse!;
      expect(receipt).toMatchObject({
        command: 'turn.start',
        requestId,
        response: { kind: 'turn', id: turn.id },
      });
      // A second store reads the already-published receipt from Workspace SQLite.
      expect(
        createDemoStore({ dataRoot, coreDb }).getCommandRequest('turn.start', requestId, scope)
      ).toEqual(receipt);

      const replay = await submit();
      expect(replay.status).toBe(token ? 200 : 202);
      const replayWire = await replay.json();
      expect(
        ProductTurnSchema.parse(token ? JSON.parse(replayWire.result.content[0].text) : replayWire)
          .id
      ).toBe(turn.id);
      expect(executor.completionObserved).toBe(false);
      const conflict = await submit('Different semantic input.');
      expect(conflict.status).toBe(token ? 200 : 409);
      const refused = await conflict.json();
      if (token) expect(refused.result.isError).toBe(true);
      expect(token ? JSON.parse(refused.result.content[0].text) : refused).toMatchObject({
        code: 'idempotency_key_conflict',
      });
      // Launch is a separate eventual predicate; a receipt may precede this tick.
      await vi.waitFor(() => expect(executor.startCalls).toBe(1));
      expect(readTurnAttempt(coreDb, turn.id)?.phase).toBe('open');
      expect(store.listThreadTurns(scope.workspaceId, scope.threadId)).toHaveLength(1);
      executor.completion.resolve();
      if (entry !== 'failure') {
        await executor.terminalPublished.promise;
        expect(store.getTurnById(turn.id).status).toBe('completed');
        expect(readTurnAttempt(coreDb, turn.id)?.phase).toBe('closing');

        let replayObserved = false;
        const closingReplay = Promise.resolve(submit()).then((r) => {
          replayObserved = true;
          return r;
        });
        await vi.waitFor(() => expect(replayObserved).toBe(true));
        // D119: this terminal owner tuple still lacks release proof. Replay refuses without waiting or resubmitting.
        const closingResponse = await closingReplay;
        expect(closingResponse.status).toBe(token ? 200 : 409);
        const closingWire = await closingResponse.json();
        if (token) expect(closingWire.result.isError).toBe(true);
        expect(token ? JSON.parse(closingWire.result.content[0].text) : closingWire).toMatchObject({
          code: 'recovery_required',
        });
        expect(executor.completionObserved).toBe(false);
        expect(readTurnAttempt(coreDb, turn.id)?.phase).toBe('closing');
        executor.cleanup.resolve();
      }
      await executor.finished.promise;
      await vi.waitFor(() =>
        expect(readTurnAttempt(coreDb, turn.id)?.phase).toBe(
          entry === 'failure' ? 'closing' : 'closed'
        )
      );
      await setImmediate();
      if (entry === 'failure') {
        // Executor entry makes execution possible; this Error supplies no fence or handoff.
        const retained = readTurnAttempt(coreDb, turn.id);
        expect(retained?.phase).toBe('closing');
        expect(store.getTurnById(turn.id).status).toBe('failed');
        const reload = openCoreDb(dataRoot);
        try {
          expect(readTurnAttempt(reload, turn.id)).toEqual(retained);
        } finally {
          reload.sqlite.close();
        }
        expect(executor.startCalls).toBe(1);

        return;
      }
      const terminal = await submit();
      expect(terminal.status).toBe(token ? 200 : 202);
      const terminalWire = await terminal.json();
      expect(
        ProductTurnSchema.parse(
          token ? JSON.parse(terminalWire.result.content[0].text) : terminalWire
        )
      ).toMatchObject({ id: turn.id, status: 'completed' });
      const lease = readTurnAttempt(coreDb, turn.id);
      expect((await submit()).status).toBe(token ? 200 : 202);
      expect(readTurnAttempt(coreDb, turn.id)).toEqual(lease);

      expect(store.getCommandRequest('turn.start', requestId, scope)).toEqual(receipt);
      expect(executor.startCalls).toBe(1);
      expect(
        schedulerOwners.listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: scope.workspaceId,
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toHaveLength(1);
    } finally {
      executor.completion.resolve();
      executor.cleanup.resolve();
      await pending.catch(() => undefined);
      if (executor.startCalls) await executor.finished.promise;
      await setImmediate();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('Core Turn receipt recovery boundary', () => {
  it.each([
    'wrong-kind',
    'missing-turn',
  ] as const)('refuses %s replay authority without changing the receipt or launching another Turn', async (fault) => {
    const executor = new HoldingTurnExecutor(false);
    const { app, coreDb, dataRoot, store } = await createSchedulerFixture(
      executor,
      fault,
      'local',
      createTestAgentSetup().manifest,
      true
    );
    const scope = { workspaceId: 'ws_demo', threadId: 'th_demo' };
    const input = {
      ...scope,
      agentId: 'agent_codex_host',
      input: 'Keep the original worker held during receipt replay.',
      requestId: '00000000-0000-4000-8000-000000000993',
    };
    /** Invokes the canonical operation with unchanged request identity and semantic input. */
    const submit = () =>
      app.request(...operationRequest('turn.start', {}, { body: JSON.stringify(input) }));
    try {
      const response = await submit();
      expect(response.status).toBe(202);
      const turn = ProductTurnSchema.parse(await response.json());
      await executor.launched.promise;
      const receipt = store.getCommandRequest('turn.start', input.requestId, scope)!;
      expect(receipt.response).toEqual({ kind: 'turn', id: turn.id });
      // Change only one result-pointer component; request identity and hash still select replay.
      const corrupted = {
        ...receipt,
        response:
          fault === 'wrong-kind'
            ? { ...receipt.response, kind: 'workspace' as const }
            : { ...receipt.response, id: 'missing-turn' },
      };
      store.recordCommandRequest(corrupted);
      const turns = store.listThreadTurns(scope.workspaceId, scope.threadId);
      const admissions = schedulerOwners.listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: scope.workspaceId,
        statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
      });
      const replay = await submit();
      expect(executor.startCalls).toBe(1);
      expect(executor.completionObserved).toBe(false);
      expect(store.listThreadTurns(scope.workspaceId, scope.threadId)).toEqual(turns);
      expect(
        schedulerOwners.listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: scope.workspaceId,
          statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
        })
      ).toEqual(admissions);
      expect(store.getCommandRequest('turn.start', input.requestId, scope)).toEqual(corrupted);
      expect(
        createDemoStore({ dataRoot, coreDb }).getCommandRequest(
          'turn.start',
          input.requestId,
          scope
        )
      ).toEqual(corrupted);
      expect(replay.status).toBe(409);
      expect(ApiErrorSchema.parse(await replay.json())).toMatchObject({
        code: 'recovery_required',
      });
    } finally {
      executor.completion.resolve();
      executor.cleanup.resolve();
      if (executor.startCalls) {
        await executor.finished.promise;
        await vi.waitFor(() =>
          expect(
            store
              .listThreadTurns(scope.workspaceId, scope.threadId)
              .every((turn) => readTurnAttempt(coreDb, turn.id)?.phase === 'closed')
          ).toBe(true)
        );
      }
      await setImmediate();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('Core Turn fast terminal admission', () => {
  it('publishes the admission receipt without waiting for already-terminal worker cleanup', async () => {
    const executor = new HoldingTurnExecutor(false);
    executor.completion.resolve();
    const { app, coreDb, dataRoot, store } = await createSchedulerFixture(
      executor,
      'fast-terminal',
      'local',
      createTestAgentSetup().manifest,
      true
    );
    const scope = { workspaceId: 'ws_demo', threadId: 'th_demo' };
    const requestId = '00000000-0000-4000-8000-000000000992';
    const pending = app.request(
      ...operationRequest(
        'turn.start',
        {},
        {
          body: JSON.stringify({
            ...scope,
            agentId: 'agent_codex_host',
            input: 'Finish before cleanup.',
            requestId,
          }),
        }
      )
    );
    let responseObserved = false;
    void pending.then(() => {
      responseObserved = true;
    });
    try {
      await executor.terminalPublished.promise;
      await setImmediate();
      expect(responseObserved).toBe(true);
      expect(executor.completionObserved).toBe(false);
      const response = await pending;
      expect(response.status).toBe(202);
      const turn = ProductTurnSchema.parse(await response.json());
      expect(turn.status).toBe('pending');
      expect(store.getTurnById(turn.id).status).toBe('completed');
      expect(store.getCommandRequest('turn.start', requestId, scope)).toMatchObject({
        response: { kind: 'turn', id: turn.id },
      });
      expect(readTurnAttempt(coreDb, turn.id)?.phase).toBe('closing');
      executor.cleanup.resolve();
      await executor.finished.promise;
      await vi.waitFor(() => expect(readTurnAttempt(coreDb, turn.id)?.phase).toBe('closed'));
    } finally {
      executor.cleanup.resolve();
      await pending.catch(() => undefined);
      await executor.finished.promise;
      await setImmediate();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
