import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { DISPLAY_PROJECTION_REFRESH_ADMISSION, FsStore } from '../lib/store.js';
import type { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  acceptSchedulerLeaseHeartbeat,
  acceptSchedulerLeaseHeartbeatByBinding,
  adoptSchedulerLeaseReconnect,
  completeSchedulerTurnLease,
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  markSchedulerSessionLeaseReleasing,
  requireSchedulerSessionLease,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
  recordTestAgentEnvironmentPackage as recordBaseTestAgentEnvironmentPackage,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  listExportableAgentEnvironmentPackageSnapshots,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import {
  deriveNanoHostAgentSessionCompatibilityKey,
  openNanoHostAgentSessionBinding,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import {
  installPendingRequestAdmission,
  raiseRecordedPendingRequest,
  recoverPendingRequestsAtBoot,
} from './pending-request-flow.js';
import {
  answerPendingRequest,
  freezeReadyOutcomes,
  readPendingRequest,
} from './pending-requests.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import {
  type RunSchedulerRestartRecoveryInput,
  runSchedulerRecoveryMaintenance,
  runSchedulerRestartRecovery,
  validateSchedulerRestartLineage,
} from './scheduler-restart-recovery.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import type { TurnExecutor } from './types.js';
import {
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionState,
} from './worker-backend-sessions.js';
import { WorkerControlGateway, type WorkerControlLineage } from './worker-control-gateway.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import type { WorkerGovernanceBackend } from './worker-governance-backend.js';
import {
  agentSessionCompatibilityKeyFromPackage,
  WorkerGovernanceTurnExecutor,
} from './worker-governance-turn-executor.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
  listBackendWorkspaceHandles,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
} from './workspace-sync-records.js';

/** Creates an isolated migrated Core database for restart recovery tests. */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-restart-')));
  applyMigrations(coreDb);
  return coreDb;
}

/** Persists the failed-start crash boundary, optionally with an outcome awaiting delivery. */
function createFailedStartFixture(suffix: string, outcome = false, anchored = true) {
  const coreDb = createMigratedCoreDb();
  const dataRoot = coreDb.dataRoot;
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId: 'ws_demo' });
  const threadId = `thread_${suffix}`;
  const turnId = `turn_${suffix}`;
  const agentSessionId = `as_${suffix}`;
  const packageSnapshotId = `aepsnap_turn_${suffix}_as_${suffix}`;
  store.createThread('ws_demo', 'Recover failed start', threadId);
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  if (outcome) {
    const raising = store.createTurn(
      'ws_demo',
      threadId,
      'Ask for input',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      { agentId: 'agent_codex_host', executorKind: 'worker' }
    );
    const questions = [
      {
        id: 'path',
        header: 'Path',
        question: 'Which path?',
        options: null,
        isOther: true,
        isSecret: false,
      },
    ];
    store.createItem({
      id: `it_request_${suffix}`,
      workspaceId: 'ws_demo',
      threadId,
      turnId: raising.id,
      type: 'user-input-request',
      responsibleUserId: LOCAL_USER_ID,
      status: 'completed',
      userInputRequestId: `input_${suffix}`,
      prompt: 'Which path?',
      questions,
      createdAt: raising.startedAt!,
      completedAt: raising.startedAt!,
    });
    raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
      requestId: `input_${suffix}`,
      requestItemId: `it_request_${suffix}`,
      workspaceId: 'ws_demo',
      threadId,
      raisingTurnId: raising.id,
      kind: 'user-input',
      requesterKind: 'worker',
      agentId: 'agent_codex_host',
      responsibleUserId: LOCAL_USER_ID,
      questions,
      questionDigest: `digest_${suffix}`,
      now: new Date().toISOString(),
    });
    store.updateTurn(raising.id, { status: 'completed', completedAt: new Date().toISOString() });
    answerPendingRequest(
      workspaceDb.sqlite,
      `input_${suffix}`,
      { kind: 'user', id: LOCAL_USER_ID },
      { path: ['src'] },
      new Date().toISOString()
    );
  }
  store.createAgentSession({
    id: agentSessionId,
    agentId: 'agent_codex_host',
    workspaceId: 'ws_demo',
    threadId,
    status: 'busy',
    message: null,
    environmentPackageSnapshotId: packageSnapshotId,
    createdAt: '2026-07-05T00:00:01.000Z',
    updatedAt: '2026-07-05T00:00:01.000Z',
  });
  const turn = store.createTurn(
    'ws_demo',
    threadId,
    'Deliver or run',
    { kind: 'user', id: LOCAL_USER_ID },
    null,
    {
      turnId,
      agentId: 'agent_codex_host',
      agentSessionId,
      status: 'pending',
      executorKind: 'worker',
    }
  );
  if (outcome)
    freezeReadyOutcomes(workspaceDb.sqlite, {
      workspaceId: 'ws_demo',
      threadId,
      turnId,
      executor: 'worker',
      agentId: 'agent_codex_host',
      cause: 'outcome',
      now: new Date().toISOString(),
    });
  store.updateTurn(turnId, { status: 'running' });
  dispatchLease(coreDb, suffix);
  if (anchored) recordBackendSession(coreDb, suffix, 'cleaned');
  else recordTestAgentEnvironmentPackage(workspaceDb, { suffix, workspaceInputIds: [] });
  completeSchedulerTurnLease(coreDb, {
    workspaceId: 'ws_demo',
    threadId,
    turnId,
    recoveryState: 'needs-evidence',
    releaseReason: 'turn-start-failed',
    terminalStatus: 'failed',
  });
  workspaceDb.sqlite.close();
  coreDb.sqlite.close();
  const restartedCore = openCoreDb(dataRoot);
  const restartedStore = new FsStore({ dataRoot });
  const workerDelivery = { startTurn: vi.fn(async () => {}) };
  const pending = {
    coreDb: restartedCore,
    agentAuthority: () => true,
    workerDelivery,
    openWorkspace: (workspaceId: string) => {
      const db = openWorkspaceDb(dataRoot, workspaceId);
      applyScopedMigrations(db);
      return db;
    },
  };
  installPendingRequestAdmission(restartedStore, pending);
  recoverPendingRequestsAtBoot(restartedStore, pending);
  const input = {
    store: restartedStore,
    now: () => '2026-10-03T00:00:00.000Z',
    projectRecoveredTurn: vi.fn(async () => ({ status: 'failed' as const })),
  };
  return {
    coreDb: restartedCore,
    store: restartedStore,
    dataRoot,
    threadId,
    turnId,
    agentSessionId,
    input,
    pending,
    workerDelivery,
    turn,
  };
}

describe('terminal failed-start product recovery', () => {
  it.each([
    'maintenance',
    'ordinary-owner',
  ] as const)('leaves complete %s publication unchanged across later passes and display refreshes', async (owner) => {
    const f = createFailedStartFixture(`repeat_${owner}`, owner === 'maintenance');
    let timestamp = f.input.now();
    f.input.now = () => timestamp;
    try {
      const display = f.store.createItem({
        id: `it_display_${owner}`,
        workspaceId: 'ws_demo',
        threadId: f.threadId,
        turnId: f.turnId,
        type: 'status',
        status: 'completed',
        level: 'warning',
        title: 'Worker Turn accepted',
        summary: 'Conversation continued with agent_codex_host.',
        createdAt: f.input.now(),
        completedAt: f.input.now(),
      });
      const recovery = await runSchedulerRestartRecovery(f.coreDb, f.input);
      if (owner === 'maintenance') {
        await runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, f.input);
      } else {
        terminalizeGovernedWorkerTurn({
          store: f.store,
          turnId: f.turnId,
          agentSessionId: f.agentSessionId,
          requestId: `request_repeat_${owner}`,
          completedAt: f.input.now(),
          errorCode: 'worker_governance_turn_failed',
          message: 'Worker turn ended without success.',
          outcome: 'failed',
        });
      }
      const eventsPath = join(
        f.store.workspaceRootPath('ws_demo'),
        'threads',
        f.threadId,
        'turns',
        f.turnId,
        'runtime',
        'events.jsonl'
      );
      const eventsBefore = readFileSync(eventsPath, 'utf8');
      const published = f.store
        .getTurnEvents(f.turnId)
        .find((event) => event.event === 'turn.completed');
      expect(published?.data).toMatchObject({
        type: 'turn-completed',
        stopReason: 'error',
        turn: { status: 'failed' },
      });
      const decided = f.store.getTurnById(f.turnId);
      const session = f.store.getAgentSession(f.agentSessionId);
      expect(session.status).toBe('failed');
      expect(
        f.store.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      timestamp = '2026-10-03T00:01:00.000Z';
      await runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, f.input);
      expect(f.store.getTurnById(f.turnId)).toEqual(decided);
      expect(f.store.getAgentSession(f.agentSessionId)).toEqual(session);
      expect(readFileSync(eventsPath, 'utf8')).toBe(eventsBefore);

      // Core Protocol admits only these named display fields after the terminal snapshot.
      f.store.updateItem(
        display.id,
        {
          title: 'Worker Turn failed',
          summary: 'Worker turn ended without success.',
        },
        DISPLAY_PROJECTION_REFRESH_ADMISSION
      );
      const restarted = new FsStore({ dataRoot: f.dataRoot });
      const current = restarted.getTurnById(f.turnId);
      expect(published?.data.type).toBe('turn-completed');
      if (published?.data.type !== 'turn-completed') throw new Error('Missing terminal snapshot.');
      expect(
        Object.keys(current).filter(
          (key) =>
            !isDeepStrictEqual(
              current[key as keyof typeof current],
              published.data.turn[key as keyof typeof current]
            )
        )
      ).toEqual(['items']);
      expect(current.items.find((item) => item.id === display.id)).toMatchObject({
        level: 'warning',
        title: 'Worker Turn failed',
        summary: 'Worker turn ended without success.',
      });
      expect(current.items).toEqual(
        published.data.turn.items.map((item) =>
          item.id === display.id
            ? {
                ...item,
                title: 'Worker Turn failed',
                summary: 'Worker turn ended without success.',
              }
            : item
        )
      );
      expect(published.data.turn.items.find((item) => item.id === display.id)).toMatchObject({
        level: 'warning',
        title: 'Worker Turn accepted',
        summary: 'Conversation continued with agent_codex_host.',
      });
      const lease = requireSchedulerSessionLease(f.coreDb, `lease_repeat_${owner}`);
      const backend = getWorkerBackendSession(f.coreDb, lease.leaseId);
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      const pending = readPendingRequest(db.sqlite, `input_repeat_${owner}`);
      db.sqlite.close();
      for (let pass = 0; pass < 2; pass += 1) {
        timestamp = new Date(Date.parse(timestamp) + 60_000).toISOString();
        await runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, {
          ...f.input,
          store: restarted,
        });
        const durable = new FsStore({ dataRoot: f.dataRoot });
        expect(durable.getTurnById(f.turnId)).toEqual(current);
        expect(durable.getAgentSession(f.agentSessionId)).toEqual(session);
        expect(readFileSync(eventsPath, 'utf8')).toBe(eventsBefore);
        expect(requireSchedulerSessionLease(f.coreDb, lease.leaseId)).toEqual(lease);
        expect(getWorkerBackendSession(f.coreDb, lease.leaseId)).toEqual(backend);
        const after = openWorkspaceDb(f.dataRoot, 'ws_demo');
        expect(readPendingRequest(after.sqlite, `input_repeat_${owner}`)).toEqual(pending);
        after.sqlite.close();
      }
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'status',
    'stop-reason',
    'agent',
    'session',
    'error-code',
    'error-message',
    'completion-time',
  ] as const)('preserves a contradictory terminal %s and still maintains an independent lease', async (contradiction) => {
    const suffix = `publication_${contradiction}`;
    const f = createFailedStartFixture(suffix);
    let timestamp = f.input.now();
    f.input.now = () => timestamp;
    try {
      const running = f.store.getTurnById(f.turnId);
      const decided = {
        ...running,
        status: 'failed' as const,
        completedAt: f.input.now(),
        durationMs: running.startedAt
          ? Math.max(0, Date.parse(f.input.now()) - Date.parse(running.startedAt))
          : running.durationMs,
        error: { code: 'worker_governance_turn_failed', message: 'The worker failed.' },
      };
      // Publish before the terminal row so the real store can represent conflicting history.
      f.store.emitTurnEvent(f.turnId, {
        workspaceId: 'ws_demo',
        threadId: f.threadId,
        turnId: f.turnId,
        requestId: `request_${suffix}`,
        event: 'turn.completed',
        data: {
          type: 'turn-completed',
          stopReason: contradiction === 'stop-reason' ? 'aborted' : 'error',
          turn: {
            ...decided,
            ...(contradiction === 'status' ? { status: 'interrupted' as const } : {}),
            ...(contradiction === 'agent' ? { agentId: 'agent_foreign' } : {}),
            ...(contradiction === 'session' ? { agentSessionId: 'as_foreign' } : {}),
            ...(contradiction === 'error-code'
              ? { error: { ...decided.error, code: 'delivery_unknown' } }
              : {}),
            ...(contradiction === 'error-message'
              ? { error: { ...decided.error, message: 'A different failure.' } }
              : {}),
            ...(contradiction === 'completion-time'
              ? { completedAt: '2026-10-02T23:59:00.000Z' }
              : {}),
          },
        },
      });
      f.store.updateTurn(f.turnId, {
        status: decided.status,
        completedAt: decided.completedAt,
        error: decided.error,
      });
      const sibling = `z_after_publication_${contradiction}`;
      f.store.createThread('ws_demo', 'Independent worker', `thread_${sibling}`);
      f.store.createAgentSession({
        id: `as_${sibling}`,
        agentId: 'agent_codex_host',
        workspaceId: 'ws_demo',
        threadId: `thread_${sibling}`,
        status: 'busy',
        message: null,
        environmentPackageSnapshotId: `aepsnap_turn_${sibling}_as_${sibling}`,
        createdAt: f.input.now(),
        updatedAt: f.input.now(),
      });
      f.store.createTurn(
        'ws_demo',
        `thread_${sibling}`,
        'Independent work',
        { kind: 'user', id: LOCAL_USER_ID },
        null,
        {
          turnId: `turn_${sibling}`,
          agentId: 'agent_codex_host',
          agentSessionId: `as_${sibling}`,
          status: 'running',
          executorKind: 'worker',
        }
      );
      dispatchLease(f.coreDb, sibling);
      recordBackendSession(f.coreDb, sibling, 'cleaned');
      completeSchedulerTurnLease(f.coreDb, {
        workspaceId: 'ws_demo',
        threadId: `thread_${sibling}`,
        turnId: `turn_${sibling}`,
        recoveryState: 'needs-evidence',
        releaseReason: 'turn-start-failed',
        terminalStatus: 'failed',
      });
      expect(
        f.coreDb.sqlite
          .prepare(
            `SELECT lease_id AS leaseId FROM scheduler_session_leases
             WHERE status = 'failed' AND release_reason = 'turn-start-failed'
               AND recovery_state = 'needs-evidence' ORDER BY lease_id`
          )
          .all()
      ).toEqual([{ leaseId: `lease_${suffix}` }, { leaseId: `lease_${sibling}` }]);
      const store = new FsStore({ dataRoot: f.dataRoot });
      const before = store.getTurnById(f.turnId);
      const session = store.getAgentSession(f.agentSessionId);
      const events = store.getTurnEventsForExport(f.turnId);
      const publication = store
        .getTurnEvents(f.turnId)
        .find((event) => event.event === 'turn.completed');
      if (publication?.data.type !== 'turn-completed')
        throw new Error('Missing contradictory snapshot.');
      const differingFields = Object.keys(before).filter(
        (key) =>
          !isDeepStrictEqual(
            before[key as keyof typeof before],
            publication.data.turn[key as keyof typeof before]
          )
      );
      expect(differingFields).toEqual(
        contradiction === 'stop-reason'
          ? []
          : [
              contradiction === 'status'
                ? 'status'
                : contradiction === 'agent'
                  ? 'agentId'
                  : contradiction === 'session'
                    ? 'agentSessionId'
                    : contradiction === 'completion-time'
                      ? 'completedAt'
                      : 'error',
            ]
      );
      const input = { ...f.input, store, cleanupBackendSession: vi.fn(async () => {}) };
      const completedAt = '2026-10-03T00:01:00.000Z';
      for (let pass = 0; pass < 2; pass += 1) {
        timestamp = new Date(Date.parse(timestamp) + 60_000).toISOString();
        await expect(runSchedulerRecoveryMaintenance(f.coreDb, 9, input)).rejects.toThrow(
          'recovery_required: Failed-start terminal publication contradicts its decided Turn.'
        );
        const durable = new FsStore({ dataRoot: f.dataRoot });
        expect(durable.getTurnById(f.turnId)).toEqual(before);
        expect(durable.getAgentSession(f.agentSessionId)).toEqual(session);
        expect(durable.getTurnEventsForExport(f.turnId)).toEqual(events);
        expect(requireSchedulerSessionLease(f.coreDb, `lease_${sibling}`).status).toBe('failed');
        expect(getWorkerBackendSession(f.coreDb, `lease_${sibling}`)?.state).toBe('cleaned');
        expect(durable.getTurnById(`turn_${sibling}`)).toMatchObject({
          status: 'failed',
          completedAt,
          error: { code: 'worker_governance_turn_failed' },
        });
        expect(durable.getAgentSession(`as_${sibling}`)).toMatchObject({
          status: 'failed',
          updatedAt: completedAt,
        });
        expect(
          durable
            .getTurnEvents(`turn_${sibling}`)
            .filter((event) => event.event === 'turn.completed')
        ).toHaveLength(1);
      }
      expect(input.cleanupBackendSession).not.toHaveBeenCalled();
      expect(f.input.projectRecoveredTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('settles unknown delivery and admits an Assistant conversation without claiming worker continuity', async () => {
    const f = createFailedStartFixture('unknown_outcome', true);
    try {
      const recovery = await runSchedulerRestartRecovery(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId).status).toBe('running');
      await runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, f.input);
      expect(f.store.getTurnById(f.turnId)).toMatchObject({
        status: 'failed',
        completedAt: f.input.now(),
        error: { code: 'delivery_unknown' },
      });
      // Failed is the existing AgentSession owner's terminal, non-reusable closure.
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('failed');
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(db.sqlite, 'input_unknown_outcome')).toMatchObject({
        delivery: 'delivery-unknown',
        deliveryTurnId: f.turnId,
      });
      db.sqlite.close();
      expect(
        f.store
          .listThreadTurns('ws_demo', f.threadId)
          .every((turn) =>
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status)
          )
      ).toBe(true);
      const executor = new SimulatedTurnExecutor();
      const app = createApp({
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
        turnExecutor: executor,
        agentManifests: [createTestAgentSetup().manifest],
        gatewayConfig: createTestGatewayConfig(),
        llmPiAiClient: {
          createChatCompletion: vi.fn(async () => ({
            id: 'chatcmpl_recovered_thread',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-5.2',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Fresh conversation admitted.' },
                finish_reason: 'stop',
              },
            ],
          })),
        } as unknown as PiAiGatewayClient,
        providerRegistry: new ProviderRegistry([
          {
            displayName: 'Fixture',
            id: 'agent-openrouter',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
      });
      const response = await app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: f.threadId },
          {
            body: JSON.stringify({
              requestId: 'fresh_after_failed_delivery',
              targetRef: 'internal-role:assistant',
              input: 'Continue with a fresh task.',
            }),
          }
        )
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({
        receivingWorkspaceId: 'ws_demo',
        receivingThreadId: f.threadId,
        turn: {
          workspaceId: 'ws_demo',
          threadId: f.threadId,
          triggerActor: { kind: 'user', id: LOCAL_USER_ID },
        },
      });
      expect(body.turn.id).not.toBe(f.turnId);
      expect(body.turn.agentSessionId).not.toBe(f.agentSessionId);
      expect(f.store.getTurnById(body.turn.id).threadId).toBe(f.threadId);
      recoverPendingRequestsAtBoot(f.store, f.pending);
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
      const after = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(after.sqlite, 'input_unknown_outcome')?.delivery).toBe(
        'delivery-unknown'
      );
      after.sqlite.close();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects a queued originating admission before changing outcome delivery or product state', async () => {
    const f = createFailedStartFixture('queued_admission', true, false);
    f.coreDb.sqlite
      .prepare("UPDATE scheduler_admission_entries SET status = 'queued' WHERE turn_id = ?")
      .run(f.turnId);
    const turn = f.store.getTurnById(f.turnId);
    const session = f.store.getAgentSession(f.agentSessionId);
    const events = f.store.getTurnEvents(f.turnId);
    const admission = f.coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries WHERE turn_id = ?')
      .get(f.turnId);
    const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
    const delivery = readPendingRequest(db.sqlite, 'input_queued_admission');
    db.sqlite.close();
    try {
      await expect(runRestartRecoveryThroughMaintenance(f.coreDb, f.input)).rejects.toThrow(
        /recovery_required/
      );
      expect(f.store.getTurnById(f.turnId)).toEqual(turn);
      expect(f.store.getAgentSession(f.agentSessionId)).toEqual(session);
      expect(f.store.getTurnEvents(f.turnId)).toEqual(events);
      expect(
        f.coreDb.sqlite
          .prepare('SELECT * FROM scheduler_admission_entries WHERE turn_id = ?')
          .get(f.turnId)
      ).toEqual(admission);
      const after = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(after.sqlite, 'input_queued_admission')).toEqual(delivery);
      after.sqlite.close();
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('recovers real worker conversation admission and successor continuity on the same Thread', async () => {
    const f = createFailedStartFixture('worker_conversation', true);
    const setup = createTestAgentSetup();
    admitTestNativeEnvironment(f.coreDb, setup.manifest);
    prepareReconnectLease(f.coreDb, 'worker_conversation_sibling');
    const recoveryInput = {
      ...f.input,
      now: () => '2026-07-05T00:01:00.000Z',
      restoreBackendSession: async () => {},
    };
    const recovery = await runSchedulerRestartRecovery(f.coreDb, recoveryInput);
    const live = requireSchedulerSessionLease(f.coreDb, 'lease_worker_conversation_sibling');
    let finishLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });
    const backend: WorkerGovernanceBackend = {
      describeCapabilities: async () => ({
        capabilities: ['container', 'transcript-sink', 'worker-control'],
        dynamicCapabilities: [],
        kind: 'openshell',
        version: 'test',
      }),
      validatePackage: async () => [],
      planSession: (pkg) => ({
        agentSessionId: pkg.scope.agentSessionId,
        backendKind: 'openshell',
        backendSessionId: testNanoHostBackendSessionId(pkg.scope.turnId),
        deploymentId: 'deployment-test',
        packageSnapshotId: pkg.snapshotId,
        runtimeTargetId: 'runtime-target-test',
        stagingDirectoryRef: `server/runtime/worker-backend-sessions/${pkg.snapshotId}`,
        transientProviderInstanceId: null,
      }),
      prepareAgentSessionContinuity: vi.fn(async () => 'absent' as const),
      materialize: vi.fn(async (pkg) => ({
        backendKind: 'openshell',
        backendStatus: {
          gatewayEndpoint: null,
          gatewayName: 'openshell',
          health: 'ready',
          version: 'test',
        },
        command: {
          argv: pkg.runtime.command.argv,
          workingDirectory: pkg.runtime.command.workingDirectory,
        },
        controlMode: pkg.control.mode,
        packageId: pkg.packageId,
        packageSnapshotId: pkg.snapshotId,
        requiredCapabilities: pkg.backend.requiredCapabilities,
        workspaceInputs: pkg.workspace.inputs.map((input) => {
          const sessionWorkspace = (
            pkg.extensions.openkit as {
              sessionWorkspace: {
                layout: { slots: Array<{ id: string; path: string }> };
                materialization: { inputs: Array<{ inputId: string; slotId: string }> };
              };
            }
          ).sessionWorkspace;
          const slotId = sessionWorkspace.materialization.inputs.find(
            (entry) => entry.inputId === input.id
          )?.slotId;
          const target = sessionWorkspace.layout.slots.find((slot) => slot.id === slotId)?.path;
          if (!target) throw new Error(`Fixture workspace target missing for ${input.id}.`);
          return { access: input.access, id: input.id, kind: input.kind, target };
        }),
        sandbox: {
          name: testNanoHostBackendSessionId(pkg.scope.turnId),
          source: 'openkit/worker-codex:dev',
          state: 'created',
        },
      })),
      launch: vi.fn(async () => {
        await launchGate;
        return { data: {}, kind: 'fixture.launch', timestamp: recoveryInput.now() };
      }),
      cleanupSession: vi.fn(async () => {}),
      update: async () => [],
      collectEvidence: async () => [],
      collectProviderRefreshStatuses: async () => [],
      collectTranscript: async () => ({ itemsJsonl: '' }),
      collectWorkspaceChanges: async () => [],
    };
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb: f.coreDb });
    const prepare = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const starts = vi.spyOn(executor, 'startTurn');
    const app = createApp({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      turnExecutor: executor,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot: f.dataRoot,
        initialSnapshot: createInMemoryRuntimeConfigSnapshot({
          dataRoot: f.dataRoot,
          agentManifests: [setup.manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              displayName: 'Fixture',
              id: 'agent-openrouter',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
          workspaceConfigs: [
            {
              workspaceId: 'ws_demo',
              path: join(f.dataRoot, 'workspaces/ws_demo/config/workspace.jsonc'),
              config: {
                schemaVersion: 1,
                workspace: { name: 'Demo Workspace', defaultAgentId: setup.manifest.id },
              },
            },
          ],
        }),
      }),
    });
    const submit = (requestId: string) =>
      app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId: 'ws_demo', threadId: f.threadId },
          {
            body: JSON.stringify({
              requestId,
              targetRef: `warm-worker:${setup.manifest.id}:default`,
              input: 'Implement the bounded recovery follow-up.',
            }),
          }
        )
      );
    try {
      const refused = await submit('worker_before_settlement');
      expect(refused.status, await refused.clone().text()).toBe(409);
      expect(await refused.json()).toMatchObject({
        code: 'recovery_required',
        message: 'The current AgentSession still owns an active Turn.',
      });
      expect(prepare).toHaveBeenCalled();
      expect(backend.prepareAgentSessionContinuity).not.toHaveBeenCalled();
      expect(starts).not.toHaveBeenCalled();
      await runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, recoveryInput);
      expect(f.store.getTurnById(f.turnId)).toMatchObject({
        status: 'failed',
        error: { code: 'delivery_unknown' },
      });
      const admitted = await submit('worker_after_settlement');
      const body = await admitted.json();
      expect(admitted.status, JSON.stringify(body)).toBe(202);
      expect(body).toMatchObject({
        receivingWorkspaceId: 'ws_demo',
        receivingThreadId: f.threadId,
        turn: {
          workspaceId: 'ws_demo',
          threadId: f.threadId,
          agentId: setup.manifest.id,
          triggerActor: { kind: 'user', id: LOCAL_USER_ID },
        },
      });
      expect(body.turn.id).not.toBe(f.turnId);
      // Product responses omit private AgentSession lineage; read its durable Turn and lease owners.
      let successorAgentSessionId: string | null | undefined;
      await vi.waitFor(
        () => {
          successorAgentSessionId = f.store.getTurnById(body.turn.id).agentSessionId;
          expect(successorAgentSessionId).toBeTruthy();
          expect(
            f.store.getAgentSession(successorAgentSessionId!),
            JSON.stringify(f.store.getTurnById(body.turn.id).error)
          ).toMatchObject({
            id: successorAgentSessionId,
            status: 'busy',
            workspaceId: 'ws_demo',
            threadId: f.threadId,
            agentId: setup.manifest.id,
          });
        },
        { timeout: 10000 }
      );
      expect(successorAgentSessionId).not.toBe(f.agentSessionId);
      expect(backend.prepareAgentSessionContinuity).toHaveBeenCalled();
      expect(starts).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(backend.launch).toHaveBeenCalledTimes(1), { timeout: 10000 });
      expect(backend.materialize).toHaveBeenCalledTimes(1);
      const launchedPackage = vi.mocked(backend.materialize).mock.calls[0]![0];
      expect(launchedPackage.scope).toMatchObject({
        workspaceId: 'ws_demo',
        threadId: f.threadId,
        turnId: body.turn.id,
        agentSessionId: successorAgentSessionId,
        requestId: 'worker_after_settlement',
      });
      const lease = f.coreDb.sqlite
        .prepare('SELECT * FROM scheduler_session_leases WHERE turn_id = ?')
        .get(body.turn.id) as { agent_session_id: string; workspace_id: string; thread_id: string };
      expect(lease).toMatchObject({
        agent_session_id: successorAgentSessionId,
        workspace_id: 'ws_demo',
        thread_id: f.threadId,
      });
      recoverPendingRequestsAtBoot(f.store, f.pending);
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(db.sqlite, 'input_worker_conversation')).toMatchObject({
        delivery: 'delivery-unknown',
        deliveryTurnId: f.turnId,
      });
      expect(
        db.sqlite
          .prepare('SELECT request_id FROM pending_requests WHERE delivery_turn_id = ?')
          .all(body.turn.id)
      ).toEqual([]);
      db.sqlite.close();
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
      expect(requireSchedulerSessionLease(f.coreDb, live.leaseId)).toEqual(live);
    } finally {
      finishLaunch();
      await Promise.allSettled(starts.mock.results.map((result) => result.value));
      await new Promise<void>((resolve) => setImmediate(resolve));
      prepare.mockRestore();
      starts.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('settles an ordinary failed-start worker with anchored cleanup %s', async (anchored) => {
    const f = createFailedStartFixture(`ordinary_${anchored}`, false, anchored);
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, f.input);
      expect(f.store.getTurnById(f.turnId)).toMatchObject({
        status: 'failed',
        error: { code: 'worker_governance_turn_failed' },
      });
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('failed');
      expect(f.input.projectRecoveredTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('finishes a crash after the decided delivery failure without replacing its bytes or duplicating publications', async () => {
    const f = createFailedStartFixture('partial_delivery', true);
    f.store.updateTurn(f.turnId, {
      status: 'failed',
      completedAt: '2026-10-02T23:59:00.000Z',
      error: { code: 'delivery_unknown', message: 'Outcome delivery could not be proved.' },
    });
    const decided = f.store.getTurnById(f.turnId);
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, f.input);
      await runSchedulerRecoveryMaintenance(f.coreDb, 9, f.input);
      expect(f.store.getTurnById(f.turnId)).toEqual(decided);
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('failed');
      const events = f.store.getTurnEvents(f.turnId);
      expect(events.filter((event) => event.event === 'turn.completed')).toHaveLength(1);
      expect(events.find((event) => event.event === 'turn.completed')?.data).toMatchObject({
        stopReason: 'error',
        turn: decided,
      });
      expect(events.filter((event) => event.event === 'agent.session.updated')).toHaveLength(1);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'package',
    'request',
    'route-token',
    'anchor',
    'runtime-binding',
    'stale-session',
  ] as const)('leaves contradictory %s lineage recovery-required without product writes', async (contradiction) => {
    const f = createFailedStartFixture(
      `contradictory_${contradiction}`,
      false,
      ['package', 'request', 'runtime-binding'].includes(contradiction)
    );
    if (contradiction === 'package')
      f.store.updateAgentSession(f.agentSessionId, {
        environmentPackageSnapshotId: 'aepsnap_other',
      });
    if (contradiction === 'request')
      f.coreDb.sqlite
        .prepare('UPDATE scheduler_admission_entries SET request_id = ? WHERE turn_id = ?')
        .run('request_other', f.turnId);
    if (contradiction === 'route-token')
      f.coreDb.sqlite
        .prepare(
          'UPDATE scheduler_session_leases SET worker_control_token_hash = ? WHERE turn_id = ?'
        )
        .run('a'.repeat(64), f.turnId);
    if (contradiction === 'anchor')
      f.coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET backend_anchor_state = 'anchored' WHERE turn_id = ?"
        )
        .run(f.turnId);
    if (contradiction === 'stale-session')
      f.store.updateAgentSession(f.agentSessionId, { stale: true });
    if (contradiction === 'runtime-binding') {
      f.coreDb.sqlite
        .prepare(`INSERT INTO sandbox_runtime_records
        (sandbox_runtime_id, runtime_target_id, origin_physical_epoch, sandbox_binding_ref,
         sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest, environment_class,
         max_open_sessions, max_harnesses, max_active_turns, lifecycle_state, health_state, drain_state,
         cleanup_state, created_at, updated_at)
        VALUES ('sandbox_contradictory', 'runtime-target-test', ?, 'sandbox-binding-contradictory',
         'integration-binding-contradictory', ?, ?, 'test', 2, 2, 1, 'open', 'ready', 'accepting', 'unknown', ?, ?)`)
        .run('a'.repeat(64), 'a'.repeat(64), 'a'.repeat(64), f.input.now(), f.input.now());
      f.coreDb.sqlite
        .prepare(`INSERT INTO harness_instance_records
        (harness_instance_id, sandbox_runtime_id, harness_binding_ref, harness_compatibility_key,
         runtime_family, adapter_id, adapter_version, protocol_version, capabilities_json, max_open_sessions,
         max_active_turns, open_session_count, active_turn_count, lifecycle_state, drain_state, next_sequence,
         operation_state, created_at, updated_at)
        VALUES ('harness_contradictory', 'sandbox_contradictory', 'harness-binding-contradictory', ?,
         'codex', 'codex', 'test', 1, '[]', 2, 1, 1, 1, 'open', 'accepting', 1, 'idle', ?, ?)`)
        .run('a'.repeat(64), f.input.now(), f.input.now());
      f.coreDb.sqlite
        .prepare(`INSERT INTO agent_session_runtime_bindings
      (agent_session_runtime_binding_id, harness_instance_id, agent_session_id, workspace_id, thread_id,
       agent_session_compatibility_key, effective_setup_generation, native_handle_state, lifecycle_state,
       current_turn_id, current_lease_id, next_turn_sequence, cleanup_state, created_at, updated_at, image_digest)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'absent', 'active', ?, ?, 1, 'unknown', ?, ?, ?)`)
        .run(
          'binding_contradictory',
          'harness_contradictory',
          f.agentSessionId,
          'ws_demo',
          f.threadId,
          'a'.repeat(64),
          f.turnId,
          `lease_contradictory_${contradiction}`,
          f.input.now(),
          f.input.now(),
          'a'.repeat(64)
        );
    }
    const before = f.store.getTurnById(f.turnId);
    try {
      await expect(runRestartRecoveryThroughMaintenance(f.coreDb, f.input)).rejects.toThrow(
        /recovery_required/
      );
      expect(f.store.getTurnById(f.turnId)).toEqual(before);
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('busy');
      expect(f.store.getTurnEvents(f.turnId)).toEqual([]);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'session',
    'terminal-event',
  ] as const)('retries a real failed %s write after the Turn decision survives a product-store reload', async (missing) => {
    const f = createFailedStartFixture(`write_failure_${missing}`, true);
    const emit = f.store.emitTurnEvent.bind(f.store);
    const fault =
      missing === 'session'
        ? vi.spyOn(f.store, 'updateAgentSession').mockImplementationOnce(() => {
            throw new Error('Injected session write failure.');
          })
        : vi.spyOn(f.store, 'emitTurnEvent').mockImplementation((...args) => {
            if (args[1].event === 'turn.completed')
              throw new Error('Injected terminal event failure.');
            return emit(...args);
          });
    try {
      const recovery = await runSchedulerRestartRecovery(f.coreDb, f.input);
      await expect(
        runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, f.input)
      ).rejects.toThrow(
        /recovery_required: Governed worker turn terminalization encountered partial persistence errors/
      );
      const decided = f.store.getTurnById(f.turnId);
      expect(decided).toMatchObject({ status: 'failed', error: { code: 'delivery_unknown' } });
      fault.mockRestore();
      const restarted = new FsStore({ dataRoot: f.dataRoot });
      const input = { ...f.input, store: restarted };
      await runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, input);
      await runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, input);
      expect(restarted.getTurnById(f.turnId)).toEqual(decided);
      expect(restarted.getAgentSession(f.agentSessionId).status).toBe('failed');
      expect(
        restarted.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      expect(
        restarted.getTurnEvents(f.turnId).filter((event) => event.event === 'agent.session.updated')
      ).toHaveLength(1);
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      fault.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it('preserves an authoritative typed refusal and proved outcome delivery while repairing publication', async () => {
    const f = createFailedStartFixture('typed_refusal', true);
    const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
    db.sqlite
      .prepare(
        "UPDATE pending_requests SET delivery = 'delivered', held_result_json = NULL WHERE delivery_turn_id = ?"
      )
      .run(f.turnId);
    const proved = readPendingRequest(db.sqlite, 'input_typed_refusal');
    db.sqlite.close();
    f.store.updateTurn(f.turnId, {
      status: 'failed',
      completedAt: '2026-10-02T23:59:00.000Z',
      error: { code: 'native_admission_refused', message: 'An authoritative native refusal.' },
    });
    const decided = f.store.getTurnById(f.turnId);
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, f.input);
      await runSchedulerRecoveryMaintenance(f.coreDb, 9, f.input);
      expect(f.store.getTurnById(f.turnId)).toEqual(decided);
      expect(f.store.getAgentSession(f.agentSessionId)).toMatchObject({
        status: 'failed',
        message: decided.error!.message,
      });
      expect(
        f.store.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      const after = openWorkspaceDb(f.dataRoot, 'ws_demo');
      expect(readPendingRequest(after.sqlite, 'input_typed_refusal')).toEqual(proved);
      after.sqlite.close();
      expect(f.workerDelivery.startTurn).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('preserves a live sibling and its exact awaiting-reconnect attempt', async () => {
    const f = createFailedStartFixture('beside_live');
    f.input.now = () => '2026-07-05T00:01:00.000Z';
    prepareReconnectLease(f.coreDb, 'surviving_sibling');
    const live = requireSchedulerSessionLease(f.coreDb, 'lease_surviving_sibling');
    try {
      const input = { ...f.input, restoreBackendSession: async () => {} };
      const recovery = await runSchedulerRestartRecovery(f.coreDb, input);
      const armed = requireSchedulerSessionLease(f.coreDb, live.leaseId);
      expect(armed).toMatchObject({ status: 'active', recoveryState: 'awaiting-reconnect' });
      await runSchedulerRecoveryMaintenance(f.coreDb, recovery.schedulerEpoch, input);
      expect(requireSchedulerSessionLease(f.coreDb, live.leaseId)).toEqual(armed);
      expect(f.store.getTurnById(f.turnId).status).toBe('failed');
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'checkpoint',
    'accepted-final',
    'live-owner',
  ] as const)('leaves an existing %s with its owner', async (owner) => {
    const suffix = `existing_${owner}`;
    const f = createFailedStartFixture(suffix);
    if (owner === 'checkpoint') {
      const db = openWorkspaceDb(f.dataRoot, 'ws_demo');
      db.sqlite
        .prepare(`INSERT INTO worker_turn_checkpoints
        (checkpoint_id, workspace_id, thread_id, turn_id, request_id, request_input_hash, stage, iteration, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running_worker', 1, ?, ?)`)
        .run(
          `checkpoint_${suffix}`,
          'ws_demo',
          f.threadId,
          f.turnId,
          `request_${suffix}`,
          'a'.repeat(64),
          f.input.now(),
          f.input.now()
        );
      db.sqlite.close();
    }
    if (owner === 'accepted-final')
      recordWorkerControlAcceptedRecord(f.coreDb, {
        acceptedAt: f.input.now(),
        lineage: {
          agentSessionId: f.agentSessionId,
          packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
          requestId: `request_${suffix}`,
          threadId: f.threadId,
          turnId: f.turnId,
          workspaceId: 'ws_demo',
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sandboxBindingRef: `lease-binding:lease_${suffix}`,
        sequence: 1,
      });
    const before = f.store.getTurnById(f.turnId);
    const session = f.store.getAgentSession(f.agentSessionId);
    try {
      await runRestartRecoveryThroughMaintenance(f.coreDb, {
        ...f.input,
        isTurnExecutionActive: () => owner === 'live-owner',
      });
      expect(f.store.getTurnById(f.turnId)).toEqual(before);
      expect(f.store.getAgentSession(f.agentSessionId)).toEqual(session);
      expect(f.store.getTurnEvents(f.turnId)).toEqual([]);
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

/** Runs the effect-free boot scan followed by one ordinary post-listener drain. */
async function runRestartRecoveryThroughMaintenance(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  input: RunSchedulerRestartRecoveryInput
) {
  const recovery = await runSchedulerRestartRecovery(coreDb, input);
  await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, input);
  return recovery;
}

/** Records one scheduler-recovery package with an explicit or default trigger actor. */
function recordTestAgentEnvironmentPackage(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  input: {
    readonly suffix: string;
    readonly triggerActor?: ActorRef;
    readonly workspaceInputIds: readonly string[];
  }
): AgentEnvironmentPackage {
  return recordBaseTestAgentEnvironmentPackage(workspaceDb, {
    suffix: input.suffix,
    triggerActor: input.triggerActor ?? { kind: 'user', id: LOCAL_USER_ID },
    workspaceInputIds: input.workspaceInputIds,
  });
}

/** Seeds one dispatchable scheduler target. */
function seedTarget(coreDb: ReturnType<typeof createMigratedCoreDb>, suffix: string): void {
  upsertSchedulerWorkerPool(coreDb, {
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 1,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: 3,
    poolId: `pool_${suffix}`,
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 3,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: '2026-07-05T00:00:00.000Z',
    poolId: `pool_${suffix}`,
    queueDepth: 0,
    targetId: `target_${suffix}`,
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    healthState: 'healthy',
    lastProbeAt: '2026-07-05T00:00:00.000Z',
    nextProbeAt: '2026-07-05T00:01:00.000Z',
    targetId: `target_${suffix}`,
  });
}

/** Dispatches one lease for restart recovery tests. */
function dispatchLease(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  triggerActor: ActorRef = { kind: 'user', id: LOCAL_USER_ID }
): void {
  seedTarget(coreDb, suffix);
  createSchedulerAdmissionEntry(coreDb, {
    triggerActor,
    priorityClass: 'interactive',
    profileRef: null,
    queueEntryId: `queue_${suffix}`,
    requestId: `request_${suffix}`,
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: `thread_${suffix}`,
    turnId: `turn_${suffix}`,
    turnInput: `Run ${suffix}`,
    workspaceId: 'ws_demo',
    now: () => '2026-07-05T00:00:01.000Z',
  });
  dispatchNextSchedulerEntry(coreDb, {
    agentSessionId: `as_${suffix}`,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 900_000,
    leaseId: `lease_${suffix}`,
    now: () => '2026-07-05T00:00:02.000Z',
    packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
    planId: `plan_${suffix}`,
    sandboxBindingRef: `lease-binding:lease_${suffix}`,
    schedulerEpoch: 7,
    startupTimeoutMs: 120_000,
  });
}

/** Returns the non-reversible lease binding for one memory-only reconnect key. */
function reconnectKeyHash(reconnectKey: string): string {
  return createHash('sha256').update(Buffer.from(reconnectKey, 'base64url')).digest('base64url');
}

/** Creates one deterministic canonical 256-bit process key for a test worker. */
function reconnectKeyFor(suffix: string): string {
  return createHash('sha256').update(`process-key-${suffix}`).digest('base64url');
}

/**
 * Seeds one anchored worker with optional durable proof that child execution started.
 *
 * @param coreDb Open Core database.
 * @param suffix Stable test identity suffix.
 * @param postLaunch Whether to record the first post-launch heartbeat.
 * @param reconnectKey Memory-only worker process key.
 * @returns Worker lineage and reconnect key.
 */
function prepareReconnectLease(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  postLaunch = true,
  reconnectKey = reconnectKeyFor(suffix)
): { readonly lineage: WorkerControlLineage; readonly reconnectKey: string } {
  dispatchLease(coreDb, suffix);
  recordBackendSession(coreDb, suffix, 'launching');
  markWorkerBackendWorkspaceHandoffComplete(coreDb, {
    leaseId: `lease_${suffix}`,
    now: () => '2026-07-05T00:00:04.000Z',
  });
  acceptSchedulerLeaseHeartbeat(coreDb, {
    heartbeatTimeoutMs: 30_000,
    leaseId: `lease_${suffix}`,
    now: () => '2026-07-05T00:00:05.000Z',
    workerProcessKeyHash: reconnectKeyHash(reconnectKey),
    workerSequence: 0,
  });
  if (postLaunch) {
    acceptSchedulerLeaseHeartbeat(coreDb, {
      heartbeatTimeoutMs: 30_000,
      leaseId: `lease_${suffix}`,
      now: () => '2026-07-05T00:00:06.000Z',
      workerSequence: 1,
    });
  }

  return {
    lineage: {
      agentSessionId: `as_${suffix}`,
      packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
      requestId: `request_${suffix}`,
      threadId: `thread_${suffix}`,
      turnId: `turn_${suffix}`,
      workspaceId: 'ws_demo',
    },
    reconnectKey,
  };
}

/** Returns one production-shaped NanoHost backend attempt identity for a fixture suffix. */
function testNanoHostBackendSessionId(suffix: string): string {
  const digest = createHash('sha256').update(suffix).digest('hex');
  return `nh-${digest.slice(0, 16)}-${digest.slice(16, 32)}`;
}

/** Records one durable backend anchor and advances it to the requested state. */
function recordBackendSession(
  coreDb: ReturnType<typeof createMigratedCoreDb>,
  suffix: string,
  state: WorkerBackendSessionState = 'materializing'
): void {
  const existingRuntimeTarget = coreDb.sqlite
    .prepare('SELECT target_id FROM nanohost_runtime_targets LIMIT 1')
    .get() as { readonly target_id: string } | undefined;
  if (!existingRuntimeTarget) {
    const allocated = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-test',
      identityId: 'identity-test',
      observedAt: '2026-07-05T00:00:00.000Z',
      targetId: 'runtime-target-test',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...allocated,
      freshEmpty: true,
      observedAt: '2026-07-05T00:00:01.000Z',
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
  }
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  try {
    applyScopedMigrations(workspaceDb);
    if (
      !listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_demo').some(
        (record) => record.snapshotId === `aepsnap_turn_${suffix}_as_${suffix}`
      )
    ) {
      recordTestAgentEnvironmentPackage(workspaceDb, { suffix, workspaceInputIds: [] });
    }
  } finally {
    workspaceDb.sqlite.close();
  }
  recordWorkerBackendSessionMaterializing(coreDb, {
    backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: `as_${suffix}`,
      backendKind: 'openshell',
      backendSessionId: testNanoHostBackendSessionId(suffix),
      deploymentId: 'deployment-test',
      packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/aepsnap_turn_${suffix}_as_${suffix}`,
      transientProviderInstanceId: null,
    },
    lineage: {
      threadId: `thread_${suffix}`,
      turnId: `turn_${suffix}`,
      workspaceId: 'ws_demo',
    },
    now: () => '2026-07-05T00:00:03.000Z',
    sandboxBindingRef: `lease-binding:lease_${suffix}`,
  });
  const path: WorkerBackendSessionState[] =
    state === 'materializing'
      ? []
      : state === 'materialized'
        ? ['materialized']
        : state === 'launching'
          ? ['materialized', 'launching']
          : state === 'cleanup-pending'
            ? ['cleanup-pending']
            : state === 'cleanup-failed'
              ? ['cleanup-pending', 'cleanup-failed']
              : state === 'physical-cleaned'
                ? ['cleanup-pending', 'physical-cleaned']
                : ['cleanup-pending', 'physical-cleaned', 'cleaned'];
  let fromState: WorkerBackendSessionState = 'materializing';
  for (const toState of path) {
    transitionWorkerBackendSessionState(coreDb, {
      fromState,
      leaseId: `lease_${suffix}`,
      toState,
    });
    fromState = toState;
  }
}

/** Records the production-shaped workspace handoff for one immutable package. */
function recordCanonicalWorkspaceHandoff(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  environmentPackage: AgentEnvironmentPackage,
  createdAt: string
): void {
  const inputSnapshots = recordWorkspaceInputSnapshots(
    workspaceDb,
    buildWorkspaceInputSnapshots({
      backendCapabilities: ['trusted-worker-inference-relay'],
      backendKind: 'openshell',
      createdAt,
      environmentPackage,
    })
  );
  recordWorkspaceMaterializationRecords(
    workspaceDb,
    buildWorkspaceMaterializationRecords({
      createdAt,
      inputSnapshots,
      materialization: {
        backendKind: 'openshell',
        backendStatus: { health: 'ready', version: '0.0.99' },
        packageSnapshotId: environmentPackage.snapshotId,
        requiredCapabilities: environmentPackage.backend.requiredCapabilities,
        sandbox: {
          name: testNanoHostBackendSessionId(
            environmentPackage.scope.agentSessionId.replace(/^as_/, '')
          ),
          state: 'created',
        },
        workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
          id: input.id,
          target: input.target,
        })),
      },
    })
  );
}

/** Executor that fails if a recovered admission is dispatched again. */
class RejectRecoveredTurnExecutor implements TurnExecutor {
  public readonly capabilities = {
    approvals: false,
    artifacts: false,
    interrupts: false,
    questions: false,
    workspaceConfig: false,
    workspaceKnowledgeEditing: false,
  };
  public readonly eventFamilies = ['turn.started'] as const;
  public readonly itemTypes = ['status'] as const;
  public readonly calls: string[] = [];

  /** Records the forbidden redispatch before failing the test. */
  public async startTurn(_store: FsStore, turnId: string): Promise<void> {
    this.calls.push(turnId);
    throw new Error(`Recovered turn was dispatched again: ${turnId}`);
  }

  /** No-op because restart recovery never invokes commands. */
  public async interruptTurn(): Promise<void> {}
}

describe('scheduler restart recovery', () => {
  it('retains a result-only poll-first unknown fence until later fresh-ready cleanup releases capacity', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'result_only_unknown_fence';
    const leaseId = `lease_${suffix}`;
    const runtimeTargetId = `target_${suffix}`;
    const effects: NanoHostSessionEffectRequest[] = [];
    const resultOnlyRejectors: Array<(error: Error) => void> = [];
    let resultOnlyRegistrations = 0;
    let rejectedResultOnlyRegistrations = 0;
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

    const createRuntime = () =>
      createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
    const recoveryInput = (
      runtime: ReturnType<typeof createConfiguredWorkerLifecycleRuntime>,
      now: () => string
    ): RunSchedulerRestartRecoveryInput => ({
      cleanupBackendSession: runtime.cleanupBackendSession,
      now,
      prepareBackendCleanup: runtime.prepareBackendCleanup,
      projectRecoveredTurn: async () => ({ status: 'failed' }),
    });
    const expectFencedAuthority = () => {
      const backendSession = getWorkerBackendSession(coreDb, leaseId);
      expect(['cleanup-pending', 'cleanup-failed']).toContain(backendSession?.state);
      expect(backendSession?.physicalCleanedAt).toBeNull();
      expect(requireSchedulerSessionLease(coreDb, leaseId).status).not.toMatch(
        /^(failed|lost|released)$/
      );
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM sandbox_runtime_records) AS sandboxes,
               (SELECT COUNT(*) FROM harness_instance_records) AS harnesses,
               (SELECT COUNT(*) FROM agent_session_runtime_bindings) AS bindings`
          )
          .get()
      ).toEqual({ bindings: 0, harnesses: 0, sandboxes: 0 });
    };
    const rejectUnexpectedRegistrations = () => {
      while (rejectedResultOnlyRegistrations < resultOnlyRejectors.length) {
        resultOnlyRejectors[rejectedResultOnlyRegistrations]?.(
          new Error('Old result-only cleanup expectation must not be registered again.')
        );
        rejectedResultOnlyRegistrations += 1;
      }
    };
    const expectMaintenanceFenced = async (
      schedulerEpoch: number,
      input: RunSchedulerRestartRecoveryInput
    ) => {
      const maintenance = runSchedulerRecoveryMaintenance(coreDb, schedulerEpoch, input);
      rejectUnexpectedRegistrations();
      await expect(maintenance).rejects.toThrow();
      expect.soft(resultOnlyRegistrations).toBe(1);
      expectFencedAuthority();
    };

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'cleanup-pending');
      coreDb.sqlite
        .prepare(
          `UPDATE worker_backend_sessions
           SET runtime_target_id = ?
           WHERE lease_id = ?`
        )
        .run(runtimeTargetId, leaseId);
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES (?, ?, 'deployment-test', 1, 1, 1, 1, ?, ?, 1)`
        )
        .run(runtimeTargetId, `identity_${suffix}`, 'a'.repeat(64), '2026-07-05T00:00:00.000Z');
      expectFencedAuthority();

      const initialRuntime = createRuntime();
      let recoveryTime = '2026-07-05T00:01:00.000Z';
      const initialInput = recoveryInput(initialRuntime, () => recoveryTime);
      const recovery = await runSchedulerRestartRecovery(coreDb, initialInput);
      expect(resultOnlyRegistrations).toBe(1);
      const initialMaintenance = runSchedulerRecoveryMaintenance(
        coreDb,
        recovery.schedulerEpoch,
        initialInput
      );
      const sameCoordinatorReadyAt = '2026-07-05T00:01:01.000Z';
      upsertNanoHostRuntimeTarget(coreDb, {
        connectionGeneration: 1,
        deploymentId: 'deployment-test',
        freshEmpty: true,
        identityId: `identity_${suffix}`,
        observedAt: sameCoordinatorReadyAt,
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
        targetId: runtimeTargetId,
      });
      recoveryTime = '2026-07-05T00:01:02.000Z';
      resultOnlyRejectors[0]?.(
        new Error('NanoHost accepted effect outcome is unknown; successor connection fenced.')
      );
      rejectedResultOnlyRegistrations = 1;
      await expect(initialMaintenance).rejects.toThrow(/unknown/i);
      expectFencedAuthority();
      const fenceObservedAt = getWorkerBackendSession(coreDb, leaseId)?.updatedAt;
      if (!fenceObservedAt) {
        throw new Error('Poll-first unknown did not retain a durable backend fence time.');
      }
      expect(fenceObservedAt).toBe(recoveryTime);
      await expectMaintenanceFenced(recovery.schedulerEpoch, initialInput);

      coreDb.sqlite
        .prepare(
          `UPDATE nanohost_runtime_targets
           SET predecessor_fenced = 1, ready = 1, fresh_empty = 1,
               physical_epoch = ?, observed_at = ?
           WHERE target_id = ?`
        )
        .run(
          'a'.repeat(64),
          new Date(Date.parse(fenceObservedAt) - 1).toISOString(),
          runtimeTargetId
        );
      await expectMaintenanceFenced(recovery.schedulerEpoch, initialInput);

      const restartedRuntime = createRuntime();
      const restartedInput = recoveryInput(restartedRuntime, () => '2026-07-05T00:01:03.000Z');
      const restartedRecovery = await runSchedulerRestartRecovery(coreDb, restartedInput);
      expect.soft(resultOnlyRegistrations).toBe(1);
      expectFencedAuthority();

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
             SET predecessor_fenced = ?, ready = ?, fresh_empty = ?,
                 physical_epoch = ?, observed_at = ?
             WHERE target_id = ?`
          )
          .run(
            predecessorFenced,
            ready,
            freshEmpty,
            ready === 1 ? 'a'.repeat(64) : null,
            new Date(Date.parse(fenceObservedAt) + observedOffsetMs).toISOString(),
            runtimeTargetId
          );
        await expectMaintenanceFenced(restartedRecovery.schedulerEpoch, restartedInput);
      }

      const successorObservedAt = new Date(Date.parse(fenceObservedAt) + 1).toISOString();
      const successor = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: `identity_${suffix}`,
        observedAt: successorObservedAt,
        targetId: runtimeTargetId,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        connectionGeneration: successor.connectionGeneration,
        deploymentId: 'deployment-test',
        freshEmpty: true,
        identityId: `identity_${suffix}`,
        observedAt: successorObservedAt,
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
        targetId: runtimeTargetId,
      });
      const finalMaintenance = runSchedulerRecoveryMaintenance(
        coreDb,
        restartedRecovery.schedulerEpoch,
        restartedInput
      );
      rejectUnexpectedRegistrations();
      await expect(finalMaintenance).resolves.toBeUndefined();

      expect(resultOnlyRegistrations).toBe(1);
      expect(effects).toEqual([]);
      expect(getWorkerBackendSession(coreDb, leaseId)).toMatchObject({
        state: 'cleaned',
      });
      expect(getWorkerBackendSession(coreDb, leaseId)?.physicalCleanedAt).not.toBeNull();
      expect(requireSchedulerSessionLease(coreDb, leaseId).status).toBe('failed');
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires exact lease, backend, package/build, process, and next-sequence lineage', () => {
    const expected = {
      agentSessionId: 'as_restart_lineage',
      backendSessionId: 'backend_restart_lineage',
      buildLineage: {
        argumentsDigest: 'sha256:arguments',
        contextDigest: 'sha256:context',
        inputDigest: 'sha256:input',
        resultingImageDigest: 'sha256:image',
      },
      leaseId: 'lease_restart_lineage',
      nextSequence: 9,
      packageSnapshotId: 'aepsnap_restart_lineage',
      processKeyHash: 'sha256:process-key',
    };

    expect(validateSchedulerRestartLineage(expected, expected)).toEqual({ accepted: true });
    for (const observed of [
      { ...expected, leaseId: 'lease-other' },
      { ...expected, backendSessionId: 'backend-other' },
      { ...expected, packageSnapshotId: 'aepsnap-other' },
      { ...expected, processKeyHash: 'sha256:other-process' },
      { ...expected, nextSequence: 8 },
      {
        ...expected,
        buildLineage: { ...expected.buildLineage, resultingImageDigest: 'sha256:other-image' },
      },
    ]) {
      expect(validateSchedulerRestartLineage(expected, observed)).toMatchObject({
        accepted: false,
      });
    }
  });

  it('fails pre-anchor acquired leases and cancels their admission entries', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      dispatchLease(coreDb, 'prelaunch');

      const result = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      const rows = coreDb.sqlite
        .prepare(
          `SELECT
            leases.status AS leaseStatus,
            leases.release_reason AS releaseReason,
            leases.scheduler_epoch AS schedulerEpoch,
            plans.status AS planStatus,
            entries.status AS queueStatus,
            capacity.in_use_count AS inUseCount,
            pools.current_admitted_session_count AS admittedCount,
            pools.current_queue_depth AS queueDepth
          FROM scheduler_session_leases AS leases
          JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
          JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
          JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
          JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
          WHERE leases.lease_id = 'lease_prelaunch'`
        )
        .get();

      expect(result).toEqual({
        preLaunchFailedLeaseIds: ['lease_prelaunch'],
        schedulerEpoch: 8,
      });
      expect(rows).toEqual({
        admittedCount: 0,
        inUseCount: 0,
        leaseStatus: 'failed',
        planStatus: 'abandoned',
        queueDepth: 0,
        queueStatus: 'cancelled',
        releaseReason: 'scheduler-restart-pre-anchor',
        schedulerEpoch: 8,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps a pre-anchor lease admitted until product projection succeeds', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'prelaunch_projection_retry';
    let projectionAttempts = 0;

    try {
      dispatchLease(coreDb, suffix);

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            projectionAttempts += 1;
            throw new Error('pre-anchor product projection failed');
          },
        })
      ).rejects.toThrow('pre-anchor product projection failed');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount,
                    pools.current_admitted_session_count AS admittedCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ admittedCount: 1, inUseCount: 1, queueStatus: 'admitted', status: 'acquired' });

      await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: async () => {
          projectionAttempts += 1;
          return { status: 'failed' as const };
        },
      });

      expect(projectionAttempts).toBe(2);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount,
                    pools.current_admitted_session_count AS admittedCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ admittedCount: 0, inUseCount: 0, queueStatus: 'cancelled', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['restart_workspace', ['repo']],
    ['restart_zero_input', []],
  ] as const)('projects %s cleanup into one package-level teardown record', async (suffix, workspaceInputIds) => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds,
      });
      if (workspaceInputIds.length > 0) {
        recordCanonicalWorkspaceHandoff(
          workspaceDb,
          environmentPackage,
          '2026-07-05T00:00:10.000Z'
        );
      }
      recordBackendSession(coreDb, suffix, 'launching');

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => undefined,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Terminal backend session must not be cleaned twice.');
        },
        now: () => '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual(
        workspaceInputIds.length > 0 ? [expect.objectContaining({ cleanupStatus: 'cleaned' })] : []
      );
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([
        expect.objectContaining({
          agentSessionId: `as_${suffix}`,
          outcome: 'succeeded',
          stopReason: 'completed',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('repairs a pending exact handoff without changing physical cleanup evidence time', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_handoff_marker_repair';
    const clocks = [
      '2026-07-05T00:01:00.000Z',
      '2026-07-05T00:01:01.000Z',
      '2026-07-05T00:01:02.000Z',
      '2026-07-05T00:01:03.000Z',
    ];

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:00:10.000Z');
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => undefined,
          now: () => clocks.shift() ?? '2026-07-05T00:01:04.000Z',
          projectRecoveredTurn: async () => {
            throw new Error('product projection crash after handoff repair');
          },
        })
      ).rejects.toThrow('product projection crash after handoff repair');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        physicalCleanedAt: '2026-07-05T00:01:03.000Z',
        state: 'physical-cleaned',
        updatedAt: '2026-07-05T00:01:04.000Z',
        workspaceHandoffState: 'complete',
      });

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Physical cleanup must not replay after marker repair.');
        },
        now: () => '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([
        expect.objectContaining({
          completedAt: '2026-07-05T00:01:03.000Z',
          outcome: 'succeeded',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('holds capacity when Core claims a complete handoff but its workspace rows are missing', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_missing_workspace_handle';
    let cleanupCalls = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordBackendSession(coreDb, suffix, 'launching');
      markWorkerBackendWorkspaceHandoffComplete(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:11.000Z',
      });

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('backend handle handoff is incomplete');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'acquired' });

      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:01:01.000Z');
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:02.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${suffix}`)
      ).toEqual({ status: 'failed' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects a workspace handle owned by a different physical backend session', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_mismatched_workspace_handle';

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        workspaceInputIds: ['repo'],
      });
      recordCanonicalWorkspaceHandoff(workspaceDb, environmentPackage, '2026-07-05T00:00:10.000Z');
      const row = workspaceDb.sqlite
        .prepare(
          'SELECT backend_workspace_handle_id AS id, payload_json AS payloadJson FROM backend_workspace_handles LIMIT 1'
        )
        .get() as { id: string; payloadJson: string };
      workspaceDb.sqlite
        .prepare(
          'UPDATE backend_workspace_handles SET payload_json = ? WHERE backend_workspace_handle_id = ?'
        )
        .run(
          JSON.stringify({
            ...(JSON.parse(row.payloadJson) as Record<string, unknown>),
            workerSessionId: 'openkit-as_attacker',
          }),
          row.id
        );
      recordBackendSession(coreDb, suffix, 'physical-cleaned');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            throw new Error('Physical cleanup must not replay.');
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('backend handle handoff is incomplete');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'acquired' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['before heartbeat', false, 'materializing'],
    ['after heartbeat', true, 'launching'],
  ] as const)('cleans and terminalizes an anchored lease %s before releasing capacity', async (_description, heartbeat, anchorState) => {
    const coreDb = createMigratedCoreDb();
    const suffix = heartbeat ? 'restart_anchor_live' : 'restart_anchor_acquired';
    const leaseId = `lease_${suffix}`;
    const cleanupObservations: unknown[] = [];

    try {
      dispatchLease(coreDb, suffix);
      if (heartbeat) {
        acceptSchedulerLeaseHeartbeat(coreDb, {
          heartbeatTimeoutMs: 900_000,
          leaseId: `lease_${suffix}`,
          now: () => '2026-07-05T00:00:10.000Z',
          workerSequence: 1,
        });
      }
      recordBackendSession(coreDb, suffix, anchorState);

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async (_session) => {
          cleanupObservations.push({
            anchor: getWorkerBackendSession(coreDb, leaseId),
            state: coreDb.sqlite
              .prepare(
                `SELECT leases.status, capacity.in_use_count AS inUseCount,
                          pools.current_admitted_session_count AS admittedCount
                   FROM scheduler_session_leases AS leases
                   JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
                   JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
                   WHERE leases.lease_id = ?`
              )
              .get(leaseId),
          });
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(cleanupObservations).toEqual([
        {
          anchor: expect.objectContaining({ state: 'cleanup-pending' }),
          state: {
            admittedCount: 1,
            inUseCount: 1,
            status: heartbeat ? 'active' : 'acquired',
          },
        },
      ]);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, leases.release_reason AS releaseReason,
                      plans.status AS planStatus, entries.status AS queueStatus,
                      capacity.in_use_count AS inUseCount,
                      pools.current_admitted_session_count AS admittedCount
               FROM scheduler_session_leases AS leases
               JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
               JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
               JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
               JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
               WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({
        admittedCount: 0,
        inUseCount: 0,
        planStatus: 'completed',
        queueStatus: 'admitted',
        releaseReason: 'scheduler-restart-backend-cleanup',
        status: 'failed',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('prepares exact result-only cleanup lineage before post-listener maintenance', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_cleanup_retry';
    let cleanupAttempts = 0;
    let preparedIdentity:
      | Parameters<NonNullable<RunSchedulerRestartRecoveryInput['prepareBackendCleanup']>>[0]
      | null = null;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordBackendSession(coreDb, suffix, 'launching');

      const recovery = await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Phase 8 must not start a physical cleanup effect.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        prepareBackendCleanup: (identity) => {
          expect(cleanupAttempts).toBe(0);
          expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
            state: 'cleanup-pending',
          });
          preparedIdentity = identity;
        },
        projectRecoveredTurn: async () => {
          throw new Error('Phase 8 must not project an anchored Turn before cleanup.');
        },
      });
      expect(cleanupAttempts).toBe(0);
      expect(preparedIdentity).toEqual({
        agentSessionId: `as_${suffix}`,
        backendKind: 'openshell',
        backendSessionId: testNanoHostBackendSessionId(suffix),
        deploymentId: 'deployment-test',
        packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
        runtimeTargetId: 'runtime-target-test',
        stagingDirectoryRef: `server/runtime/worker-backend-sessions/aepsnap_turn_${suffix}_as_${suffix}`,
        transientProviderInstanceId: null,
      });
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount,
                    pools.current_admitted_session_count AS admittedCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             JOIN scheduler_worker_pools AS pools ON pools.pool_id = leases.pool_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ admittedCount: 1, inUseCount: 1, queueStatus: 'admitted', status: 'active' });

      await expect(
        runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
          cleanupBackendSession: async () => {
            cleanupAttempts += 1;
            throw new Error('NanoHost cleanup failed');
          },
          now: () => '2026-07-05T00:01:01.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('NanoHost cleanup failed');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-failed',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });

      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {
          cleanupAttempts += 1;
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:02.000Z',
      });
      expect(cleanupAttempts).toBe(2);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${suffix}`)
      ).toEqual({ status: 'failed' });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toEqual([expect.objectContaining({ outcome: 'succeeded' })]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('terminalizes a cleaned releasing anchor without cleanup, redispatch, or adoption', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_already_cleaned';
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 900_000,
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      recordBackendSession(coreDb, suffix, 'cleaned');
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:11.000Z',
        releaseReason: 'worker-final-status',
      });

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        now: () => '2026-07-05T00:01:00.000Z',
      });

      expect(cleanupCalls).toBe(0);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, queueStatus: 'admitted', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('cleans a stale anchored lease instead of skipping it with capacity occupied', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_stale_anchor';

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'launching');
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'heartbeat-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${suffix}`);

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => undefined,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, queueStatus: 'admitted', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects an expired cleaned releasing lease before one unified terminal release', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_cleaned_expired_release';
    const projectionStates: unknown[] = [];
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'cleaned');
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });
      coreDb.sqlite
        .prepare('UPDATE scheduler_session_leases SET expires_at = ? WHERE lease_id = ?')
        .run('2026-07-05T00:00:30.000Z', `lease_${suffix}`);

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => {
          projectionStates.push(
            coreDb.sqlite
              .prepare(
                `SELECT leases.status, capacity.in_use_count AS inUseCount
                 FROM scheduler_session_leases AS leases
                 JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
                 WHERE leases.lease_id = ?`
              )
              .get(`lease_${suffix}`)
          );
          return { status: 'failed' as const };
        },
      });

      expect(cleanupCalls).toBe(0);
      expect(projectionStates).toEqual([{ inUseCount: 1, status: 'releasing' }]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, queueStatus: 'admitted', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('maps an already completed product turn to a released lease without failing it', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_completed_product';

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'cleaned');

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Cleaned session must not be cleaned twice.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'completed' as const }),
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, leases.release_reason AS releaseReason,
                    entries.status AS queueStatus, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({
        inUseCount: 0,
        queueStatus: 'admitted',
        releaseReason: 'scheduler-restart-turn-completed',
        status: 'released',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps cleaned backend capacity occupied until product turn projection succeeds', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_projection_retry';
    let projectionAttempts = 0;
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            projectionAttempts += 1;
            throw new Error('product store write failed');
          },
        })
      ).rejects.toThrow('product store write failed');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'acquired' });

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: async () => {
          projectionAttempts += 1;
          return { status: 'failed' as const };
        },
      });
      expect(cleanupCalls).toBe(1);
      expect(projectionAttempts).toBe(2);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('replays a cleaned zero-input teardown at a later time without duplicating evidence', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_cleaned_evidence_replay';
    let cleanupCalls = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix);
      recordTestAgentEnvironmentPackage(workspaceDb, { suffix, workspaceInputIds: [] });
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => {
            throw new Error('crash after cleanup projection');
          },
        })
      ).rejects.toThrow('crash after cleanup projection');
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
        updatedAt: '2026-07-05T00:01:00.000Z',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:05:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${suffix}`)
      ).toEqual({ status: 'failed' });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects a pre-anchor product turn once and prevents its durable admission from redispatch', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-restart-product-projection-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turnId = 'turn_restart_product_projection';
    const agentSessionId = 'as_restart_product_projection';
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Recover this turn',
      { kind: 'user', id: 'user_local' },
      null,
      { turnId }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: turn.startedAt ?? '2026-07-05T00:00:01.000Z',
      id: agentSessionId,
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: turn.startedAt ?? '2026-07-05T00:00:01.000Z',
      workspaceId: turn.workspaceId,
    });
    seedTarget(coreDb, 'product_projection');
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_local' },
      priorityClass: 'interactive',
      profileRef: null,
      queueEntryId: 'queue_product_projection',
      requestedAgentId: 'agent_codex_host',
      requiredPoolConstraints: ['openshell.local'],
      threadId: turn.threadId,
      turnId,
      turnInput: 'Recover this turn',
      workspaceId: turn.workspaceId,
      now: () => '2026-07-05T00:00:01.000Z',
    });
    dispatchNextSchedulerEntry(coreDb, {
      agentSessionId,
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      leaseDurationMs: 900_000,
      leaseId: 'lease_product_projection',
      now: () => '2026-07-05T00:00:02.000Z',
      packageSnapshotId: 'aepsnap_product_projection',
      planId: 'plan_product_projection',
      sandboxBindingRef: 'lease-binding:lease_product_projection',
      schedulerEpoch: 7,
      startupTimeoutMs: 120_000,
    });
    const project = async () => {
      const result = terminalizeGovernedWorkerTurn({
        agentSessionId,
        completedAt: '2026-07-05T00:01:00.000Z',
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker execution stopped during NanoCore restart recovery.',
        outcome: 'failed',
        requestId: null,
        store: new FsStore({ dataRoot }),
        turnId,
      });
      expect(result.status).toBe('failed');
      return { status: 'failed' as const };
    };

    try {
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Pre-anchor recovery must not clean a backend session.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: project,
      });
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('Terminal recovery must not clean a backend session.');
        },
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: project,
      });

      const restartedStore = new FsStore({ dataRoot });
      expect(restartedStore.getTurnById(turnId)).toMatchObject({
        error: {
          code: 'worker_governance_restart_recovery',
          message: 'Worker execution stopped during NanoCore restart recovery.',
        },
        status: 'failed',
      });
      expect(restartedStore.getAgentSession(agentSessionId)).toMatchObject({
        message: 'Worker execution stopped during NanoCore restart recovery.',
        status: 'failed',
      });
      expect(
        restartedStore
          .getTurnEvents(turnId)
          .filter(
            (event) =>
              event.event === 'turn.completed' &&
              event.data.type === 'turn-completed' &&
              event.data.stopReason === 'error'
          )
      ).toHaveLength(1);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get('lease_product_projection')
      ).toEqual({ inUseCount: 0, queueStatus: 'cancelled', status: 'failed' });

      const turnExecutor = new RejectRecoveredTurnExecutor();
      const retry = await runSchedulerDispatchLoop({
        agentManifests: [
          {
            adapter: 'custom-http',
            deployments: ['local'],
            displayName: 'Codex Agent',
            id: 'agent_codex_host',
            kind: 'custom',
            runtime: 'custom',
            version: '0.0.2',
          },
        ],
        coreDb,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        providerRegistry: new ProviderRegistry([]),
        schedulerEpoch: 9,
        startupTimeoutMs: 120_000,
        store: restartedStore,
        turnExecutor,
      });
      expect(retry.startedTurns).toEqual([]);
      expect(retry.terminalResult).toEqual({ reason: 'no-queued-entry', status: 'queued' });
      expect(turnExecutor.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'starting',
    'active',
    'idle',
    'releasing',
  ] as const)('fails critical restart for %s lease without a durable backend anchor', async (status) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `restart_missing_anchor_${status}`;

    try {
      dispatchLease(coreDb, suffix);
      coreDb.sqlite
        .prepare('UPDATE scheduler_session_leases SET status = ? WHERE lease_id = ?')
        .run(status, `lease_${suffix}`);

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => undefined,
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no durable backend session anchor');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
               FROM scheduler_session_leases AS leases
               JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
               WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails a stale pre-anchor lease that has no accepted launch heartbeat', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_prelaunch';

    try {
      dispatchLease(coreDb, suffix);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'startup-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${suffix}`);

      await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:03:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, entries.status AS queueStatus,
                    capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_placement_plans AS plans ON plans.plan_id = leases.plan_id
             JOIN scheduler_admission_entries AS entries ON entries.queue_entry_id = plans.queue_entry_id
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 0, queueStatus: 'cancelled', status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('holds capacity for a stale post-launch lease that has no durable backend anchor', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_launched';

    try {
      dispatchLease(coreDb, suffix);
      acceptSchedulerLeaseHeartbeat(coreDb, {
        heartbeatTimeoutMs: 30_000,
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        workerSequence: 1,
      });
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'heartbeat-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${suffix}`);

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no durable backend session anchor');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'stale' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not treat a stale starting lease without a heartbeat as proven pre-anchor', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_stale_starting';

    try {
      dispatchLease(coreDb, suffix);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'heartbeat-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${suffix}`);

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no durable backend session anchor');
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${suffix}`)
      ).toEqual({ status: 'stale' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails critical for an expired releasing lease without an anchor before grace release', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'restart_missing_anchor_expired_releasing';

    try {
      dispatchLease(coreDb, suffix);
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:10.000Z',
        releaseReason: 'worker-final-status',
      });

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          now: () => '2026-07-05T00:06:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('has no durable backend session anchor');
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
             FROM scheduler_session_leases AS leases
             JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
             WHERE leases.lease_id = ?`
          )
          .get(`lease_${suffix}`)
      ).toEqual({ inUseCount: 1, status: 'releasing' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects recovery into the owner-independent workspace for a non-local admission user', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_owner_workspace';
    const triggerActor = {
      kind: 'automation',
      id: 'automation_recovery_owner',
      responsibleUserId: 'user_recovery_owner',
    } as const;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix, triggerActor);
      recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        triggerActor,
        workspaceInputIds: [],
      });
      recordBackendSession(coreDb, suffix, 'launching');

      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => undefined,
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(
        listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
          (record) => record.phase === 'teardown'
        )
      ).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects restart recovery when the package trigger actor differs from admission', async () => {
    const coreDb = createMigratedCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    const suffix = 'restart_actor_mismatch';
    let cleanupCalls = 0;

    try {
      applyScopedMigrations(workspaceDb);
      dispatchLease(coreDb, suffix, {
        kind: 'automation',
        id: 'automation_admission',
        responsibleUserId: 'user_recovery_owner',
      });
      recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix,
        triggerActor: {
          kind: 'automation',
          id: 'automation_package',
          responsibleUserId: 'user_recovery_owner',
        },
        workspaceInputIds: [],
      });
      recordBackendSession(coreDb, suffix, 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('does not match scheduler trigger actor');

      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'physical-cleaned',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('attempts every anchored cleanup before reporting aggregated restart failure', async () => {
    const coreDb = createMigratedCoreDb();
    const cleanupCalls: string[] = [];

    try {
      dispatchLease(coreDb, 'aggregate_a');
      dispatchLease(coreDb, 'aggregate_b');
      recordBackendSession(coreDb, 'aggregate_a', 'launching');
      recordBackendSession(coreDb, 'aggregate_b', 'launching');

      await expect(
        runRestartRecoveryThroughMaintenance(coreDb, {
          cleanupBackendSession: async (session) => {
            cleanupCalls.push(session.backendSessionId);
            if (session.backendSessionId === testNanoHostBackendSessionId('aggregate_a')) {
              throw new Error('aggregate cleanup A failed');
            }
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('aggregate cleanup A failed');

      expect(cleanupCalls).toEqual([
        testNanoHostBackendSessionId('aggregate_a'),
        testNanoHostBackendSessionId('aggregate_b'),
      ]);
      expect(getWorkerBackendSession(coreDb, 'lease_aggregate_a')).toMatchObject({
        state: 'cleanup-failed',
      });
      expect(getWorkerBackendSession(coreDb, 'lease_aggregate_b')).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_aggregate_b')
      ).toEqual({ status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fences mismatched product lineage before any physical cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'mismatched_package');
      recordBackendSession(coreDb, 'mismatched_package', 'launching');
      coreDb.sqlite
        .prepare('UPDATE worker_backend_sessions SET thread_id = ? WHERE lease_id = ?')
        .run('thread_attacker', 'lease_mismatched_package');

      await expect(
        runSchedulerRestartRecovery(coreDb, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('does not match scheduler lineage');

      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_mismatched_package')).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_mismatched_package')
      ).toEqual({ status: 'acquired' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('boots with an unowned backend anchor and retires it after definite cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'orphan_anchor');
      recordBackendSession(coreDb, 'orphan_anchor', 'launching');
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_session_leases WHERE lease_id = ?')
        .run('lease_orphan_anchor');

      const recovery = await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_anchor')).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });
      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_anchor')).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 0 });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT action FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
          )
          .get()
      ).toEqual({ action: 'scheduler.orphan-backend-retired' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps an orphan and its capacity fenced when physical cleanup fails', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      dispatchLease(coreDb, 'orphan_cleanup_failure');
      recordBackendSession(coreDb, 'orphan_cleanup_failure', 'launching');
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_session_leases WHERE lease_id = ?')
        .run('lease_orphan_cleanup_failure');
      const recovery = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await expect(
        runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
          cleanupBackendSession: async () => {
            throw new Error('backend unavailable');
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('backend unavailable');
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_cleanup_failure')).toMatchObject({
        state: 'cleanup-failed',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('finishes retirement of an orphan already physically cleaned before restart', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      dispatchLease(coreDb, 'orphan_physical_cleaned');
      recordBackendSession(coreDb, 'orphan_physical_cleaned', 'physical-cleaned');
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_session_leases WHERE lease_id = ?')
        .run('lease_orphan_physical_cleaned');
      const recovery = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      let cleanupCalls = 0;
      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_orphan_physical_cleaned')).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retires a terminal lease backend anchor without changing that lease', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      dispatchLease(coreDb, 'terminal_dirty_anchor');
      recordBackendSession(coreDb, 'terminal_dirty_anchor', 'launching');
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'failed', release_reason = 'corrupt-terminal' WHERE lease_id = ?"
        )
        .run('lease_terminal_dirty_anchor');

      const recovery = await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_terminal_dirty_anchor')).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });
      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, 'lease_terminal_dirty_anchor')).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 0 });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get('lease_terminal_dirty_anchor')
      ).toEqual({ status: 'failed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects contradictory terminal lease and executing plan placement before cleanup', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;
    try {
      dispatchLease(coreDb, 'terminal_placement_conflict');
      recordBackendSession(coreDb, 'terminal_placement_conflict', 'launching');
      seedTarget(coreDb, 'other_placement');
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'failed', release_reason = 'corrupt-terminal' WHERE lease_id = ?"
        )
        .run('lease_terminal_placement_conflict');
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_placement_plans SET selected_target_id = ?, selected_pool_id = ? WHERE plan_id = ?'
        )
        .run('target_other_placement', 'pool_other_placement', 'plan_terminal_placement_conflict');
      const recovery = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await expect(
        runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
          cleanupBackendSession: async () => {
            cleanupCalls += 1;
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('contradictory scheduler capacity placement');
      expect(cleanupCalls).toBe(0);
      expect(getWorkerBackendSession(coreDb, 'lease_terminal_placement_conflict')).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count AS inUseCount FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_terminal_placement_conflict')
      ).toEqual({ inUseCount: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('releases only the orphan boundary and preserves an unrelated capacity fence', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      dispatchLease(coreDb, 'scoped_orphan');
      recordBackendSession(coreDb, 'scoped_orphan', 'launching');
      coreDb.sqlite
        .prepare('DELETE FROM scheduler_session_leases WHERE lease_id = ?')
        .run('lease_scoped_orphan');
      seedTarget(coreDb, 'separate_fence');
      coreDb.sqlite
        .prepare('UPDATE scheduler_capacity_records SET in_use_count = 1 WHERE target_id = ?')
        .run('target_separate_fence');
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_worker_pools SET current_admitted_session_count = 1 WHERE pool_id = ?'
        )
        .run('pool_separate_fence');
      const unrelatedBefore = coreDb.sqlite
        .prepare(
          'SELECT in_use_count AS inUseCount, version FROM scheduler_capacity_records WHERE target_id = ?'
        )
        .get('target_separate_fence');
      const recovery = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {},
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count AS inUseCount FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_scoped_orphan')
      ).toEqual({ inUseCount: 0 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count AS inUseCount, version FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_separate_fence')
      ).toEqual(unrelatedBefore);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT current_admitted_session_count AS count FROM scheduler_worker_pools WHERE pool_id = ?'
          )
          .get('pool_separate_fence')
      ).toEqual({ count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retires two no-lease sessions on one target after both physical cleanups', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      for (const suffix of ['shared_first', 'shared_second']) {
        dispatchLease(coreDb, suffix);
        recordBackendSession(coreDb, suffix, 'launching');
        coreDb.sqlite
          .prepare('DELETE FROM scheduler_session_leases WHERE lease_id = ?')
          .run(`lease_${suffix}`);
      }
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_placement_plans SET selected_target_id = ?, selected_pool_id = ? WHERE plan_id = ?'
        )
        .run('target_shared_first', 'pool_shared_first', 'plan_shared_second');
      coreDb.sqlite
        .prepare('UPDATE scheduler_capacity_records SET in_use_count = 2 WHERE target_id = ?')
        .run('target_shared_first');
      coreDb.sqlite
        .prepare('UPDATE scheduler_capacity_records SET in_use_count = 0 WHERE target_id = ?')
        .run('target_shared_second');
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_worker_pools SET current_admitted_session_count = 2 WHERE pool_id = ?'
        )
        .run('pool_shared_first');
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_worker_pools SET current_admitted_session_count = 0 WHERE pool_id = ?'
        )
        .run('pool_shared_second');
      seedTarget(coreDb, 'shared_unrelated');
      coreDb.sqlite
        .prepare('UPDATE scheduler_capacity_records SET in_use_count = 1 WHERE target_id = ?')
        .run('target_shared_unrelated');
      const unrelatedBefore = coreDb.sqlite
        .prepare(
          'SELECT in_use_count AS inUseCount, version FROM scheduler_capacity_records WHERE target_id = ?'
        )
        .get('target_shared_unrelated');
      const recovery = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      let cleanupCalls = 0;
      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(cleanupCalls).toBe(2);
      for (const suffix of ['shared_first', 'shared_second']) {
        expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
          state: 'cleaned',
        });
      }
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count AS inUseCount FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_shared_first')
      ).toEqual({ inUseCount: 0 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT current_admitted_session_count AS count FROM scheduler_worker_pools WHERE pool_id = ?'
          )
          .get('pool_shared_first')
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
          )
          .get()
      ).toEqual({ count: 2 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count AS inUseCount, version FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_shared_unrelated')
      ).toEqual(unrelatedBefore);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps shared orphan capacity fenced until a failed physical cleanup later succeeds', async () => {
    const coreDb = createMigratedCoreDb();
    try {
      for (const suffix of ['failed_shared_first', 'failed_shared_second']) {
        dispatchLease(coreDb, suffix);
        recordBackendSession(coreDb, suffix, 'launching');
        coreDb.sqlite
          .prepare('DELETE FROM scheduler_session_leases WHERE lease_id = ?')
          .run(`lease_${suffix}`);
      }
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_placement_plans SET selected_target_id = ?, selected_pool_id = ? WHERE plan_id = ?'
        )
        .run('target_failed_shared_first', 'pool_failed_shared_first', 'plan_failed_shared_second');
      coreDb.sqlite
        .prepare('UPDATE scheduler_capacity_records SET in_use_count = 2 WHERE target_id = ?')
        .run('target_failed_shared_first');
      coreDb.sqlite
        .prepare('UPDATE scheduler_capacity_records SET in_use_count = 0 WHERE target_id = ?')
        .run('target_failed_shared_second');
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_worker_pools SET current_admitted_session_count = 2 WHERE pool_id = ?'
        )
        .run('pool_failed_shared_first');
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_worker_pools SET current_admitted_session_count = 0 WHERE pool_id = ?'
        )
        .run('pool_failed_shared_second');
      const recovery = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await expect(
        runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
          cleanupBackendSession: async (session) => {
            if (session.agentSessionId === 'as_failed_shared_second')
              throw new Error('second cleanup unavailable');
          },
          now: () => '2026-07-05T00:01:00.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        })
      ).rejects.toThrow('second cleanup unavailable');
      expect(getWorkerBackendSession(coreDb, 'lease_failed_shared_first')).toMatchObject({
        state: 'physical-cleaned',
      });
      expect(getWorkerBackendSession(coreDb, 'lease_failed_shared_second')).toMatchObject({
        state: 'cleanup-failed',
      });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
          )
          .get()
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count AS inUseCount FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_failed_shared_first')
      ).toEqual({ inUseCount: 2 });
      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {},
        now: () => '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      expect(getWorkerBackendSession(coreDb, 'lease_failed_shared_first')).toMatchObject({
        state: 'cleaned',
      });
      expect(getWorkerBackendSession(coreDb, 'lease_failed_shared_second')).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'scheduler.orphan-backend-retired'"
          )
          .get()
      ).toEqual({ count: 2 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT in_use_count AS inUseCount FROM scheduler_capacity_records WHERE target_id = ?'
          )
          .get('target_failed_shared_first')
      ).toEqual({ inUseCount: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

describe('minimal scheduler reconnect contract', () => {
  it('cleans a sequence-zero-only process without claiming it launched work', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      prepareReconnectLease(coreDb, 'prelaunch_only', false);
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(1);
      expect(requireSchedulerSessionLease(coreDb, 'lease_prelaunch_only')).toMatchObject({
        recoveryState: null,
        status: 'failed',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('arms one bounded awaiting-reconnect lease without extending its deadline on replay', async () => {
    const coreDb = createMigratedCoreDb();
    let projectionCalls = 0;

    try {
      prepareReconnectLease(coreDb, 'bounded_reconnect');
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error('An eligible survivor must not be cleaned before its deadline.');
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => {
          projectionCalls += 1;
          return { status: 'failed' as const };
        },
        restoreBackendSession: async () => {},
      });
      const first = requireSchedulerSessionLease(coreDb, 'lease_bounded_reconnect');
      const reconnectWindowMs =
        Date.parse(first.recoveryDeadline ?? '') - Date.parse('2026-07-05T00:01:00.000Z');

      expect(first).toMatchObject({ recoveryState: 'awaiting-reconnect', status: 'active' });
      expect(reconnectWindowMs).toBe(300_000);

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          throw new Error(
            'A replayed boot must not clean a survivor before its original deadline.'
          );
        },
        now: () => '2026-07-05T00:01:01.000Z',
        projectRecoveredTurn: async () => {
          projectionCalls += 1;
          return { status: 'failed' as const };
        },
        restoreBackendSession: async () => {},
      });

      expect(requireSchedulerSessionLease(coreDb, 'lease_bounded_reconnect')).toMatchObject({
        recoveryDeadline: first.recoveryDeadline,
        recoveryState: 'awaiting-reconnect',
      });
      expect(projectionCalls).toBe(0);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('hydrates one same-Epoch survivor while readiness is absent and rejects a different Epoch', async () => {
    const coreDb = createMigratedCoreDb();
    const suffix = 'graceful_same_epoch_reconnect';
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    store.createThread('ws_demo', 'Same-Epoch restart fixture', `thread_${suffix}`);
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-07-05T00:00:01.000Z',
      environmentPackageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
      id: `as_${suffix}`,
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: null,
      status: 'busy',
      threadId: `thread_${suffix}`,
      updatedAt: '2026-07-05T00:00:01.000Z',
      workspaceId: 'ws_demo',
      workspaceRoots: [],
    });
    const fixture = prepareReconnectLease(coreDb, suffix);
    const leaseId = `lease_${suffix}`;
    const runtimeTargetId = 'runtime-target-test';
    let cleanupRegistrations = 0;
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'image.acquire') {
          return { digest: request.input.imageReference };
        }
        if (request.kind === 'image.inspect') {
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
              targets: [{ target: '/sandbox' }, { target: '/workspace' }],
              uid: 1000,
              version: '1',
              workingDirectory: '/tmp/openkit-bootstrap',
            },
          };
        }
        if (request.kind === 'sandbox.create') {
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
            storage: {
              ...storage,
              targets: storage.targets.map((target) => ({ ...target, initialized: true })),
            },
          };
        }
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      expectResultOnly() {
        cleanupRegistrations += 1;
        return new Promise<never>(() => undefined);
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
          `INSERT OR IGNORE INTO users (
             id, display_name, email, email_verified, kind, status, created_at, updated_at
           ) VALUES (?, ?, ?, 0, 'human', 'active', 0, 0)`
        )
        .run(LOCAL_USER_ID, LOCAL_USER_ID, 'local@restart-fixture.openkit.invalid');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: LOCAL_USER_ID,
        workspaceId: 'ws_demo',
      });
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      let environmentPackage: AgentEnvironmentPackage;
      try {
        applyScopedMigrations(workspaceDb);
        environmentPackage = requireAgentEnvironmentPackageSnapshot(
          workspaceDb,
          'ws_demo',
          `aepsnap_turn_${suffix}_as_${suffix}`
        ).snapshot;
      } finally {
        workspaceDb.sqlite.close();
      }

      const initialRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const initialBackend = (
        initialRuntime.turnExecutor as unknown as {
          readonly backend: {
            materialize(
              environmentPackage: AgentEnvironmentPackage,
              context: { readonly workspaceRoots: [] }
            ): Promise<unknown>;
            planSession(environmentPackage: AgentEnvironmentPackage): {
              readonly backendSessionId: string;
            };
          };
        }
      ).backend;
      coreDb.sqlite
        .prepare(
          `UPDATE worker_backend_sessions
           SET backend_session_id = ?
           WHERE lease_id = ?`
        )
        .run(initialBackend.planSession(environmentPackage).backendSessionId, leaseId);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-07-05T00:00:07.000Z'));
      try {
        await initialBackend.materialize(environmentPackage, { workspaceRoots: [] });
      } finally {
        vi.useRealTimers();
      }
      const harness = coreDb.sqlite
        .prepare(
          `SELECT h.adapter_id AS adapterId, h.adapter_version AS adapterVersion,
                  h.harness_compatibility_key AS harnessCompatibilityKey,
                  h.harness_instance_id AS harnessInstanceId
           FROM harness_instance_records h
           JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
           WHERE s.origin_physical_epoch = ?`
        )
        .get('a'.repeat(64)) as {
        readonly adapterId: 'codex';
        readonly adapterVersion: string;
        readonly harnessCompatibilityKey: string;
        readonly harnessInstanceId: string;
      };
      const agentSessionCompatibilityKey = deriveNanoHostAgentSessionCompatibilityKey({
        adapterId: harness.adapterId,
        adapterVersion: harness.adapterVersion,
        harnessCompatibilityKey: harness.harnessCompatibilityKey,
        sessionCompatibilityKey: agentSessionCompatibilityKeyFromPackage(environmentPackage),
        threadId: environmentPackage.scope.threadId,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey,
        agentSessionId: environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: `binding_${suffix}`,
        effectiveSetupGeneration: 1,
        harnessInstanceId: harness.harnessInstanceId,
        threadId: environmentPackage.scope.threadId,
        timestamp: '2026-07-05T00:00:07.000Z',
        workspaceId: environmentPackage.scope.workspaceId,
      });
      effects.length = 0;
      recordNanoHostRuntimeTargetConnectionClose(coreDb, {
        authoritativeGeneration: null,
        closedGeneration: 1,
        observedAt: '2026-07-05T00:00:08.000Z',
        targetId: runtimeTargetId,
      });

      const restartedRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      await expect(
        restartedRuntime.restoreBackendSession(getWorkerBackendSession(coreDb, leaseId)!)
      ).resolves.toBeUndefined();
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: restartedRuntime.cleanupBackendSession,
        now: () => '2026-07-05T00:01:00.000Z',
        prepareBackendCleanup: restartedRuntime.prepareBackendCleanup,
        projectRecoveredTurn: async () => ({ status: 'failed' }),
        restoreBackendSession: restartedRuntime.restoreBackendSession,
      });

      expect(requireSchedulerSessionLease(coreDb, leaseId)).toMatchObject({
        recoveryState: 'awaiting-reconnect',
        status: 'active',
      });
      expect(cleanupRegistrations).toBe(0);
      expect(effects).toEqual([]);
      const restartedBackend = (
        restartedRuntime.turnExecutor as unknown as {
          readonly backend: {
            prepareAgentSessionContinuity(input: {
              readonly agentSessionCompatibilityKey: string;
              readonly agentSessionId: string;
              readonly reuseAllowed: true;
              readonly threadId: string;
              readonly workspaceId: string;
            }): Promise<unknown>;
          };
        }
      ).backend;
      await expect(
        restartedBackend.prepareAgentSessionContinuity({
          agentSessionCompatibilityKey,
          agentSessionId: environmentPackage.scope.agentSessionId,
          reuseAllowed: true,
          threadId: environmentPackage.scope.threadId,
          workspaceId: environmentPackage.scope.workspaceId,
        })
      ).rejects.toThrow(/not ready for admission/i);
      expect(() =>
        adoptSchedulerLeaseReconnect(coreDb, {
          acceptedAt: '2026-07-05T00:01:01.000Z',
          lineage: fixture.lineage,
          reconnectKey: fixture.reconnectKey,
          sandboxBindingRef: `lease-binding:${leaseId}`,
          workerSequence: 2,
        })
      ).toThrow(
        expect.objectContaining({
          reason: 'reconnect-required',
        })
      );

      const differentGeneration = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'identity-test',
        observedAt: '2026-07-05T00:01:02.000Z',
        targetId: runtimeTargetId,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...differentGeneration,
        freshEmpty: true,
        observedAt: '2026-07-05T00:01:03.000Z',
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      expect(() =>
        adoptSchedulerLeaseReconnect(coreDb, {
          acceptedAt: '2026-07-05T00:01:04.000Z',
          lineage: fixture.lineage,
          reconnectKey: fixture.reconnectKey,
          sandboxBindingRef: `lease-binding:${leaseId}`,
          workerSequence: 2,
        })
      ).toThrow(
        expect.objectContaining({
          reason: 'lease-changed',
        })
      );

      const sameGeneration = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'identity-test',
        observedAt: '2026-07-05T00:01:05.000Z',
        targetId: runtimeTargetId,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...sameGeneration,
        freshEmpty: true,
        observedAt: '2026-07-05T00:01:06.000Z',
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      expect(
        adoptSchedulerLeaseReconnect(coreDb, {
          acceptedAt: '2026-07-05T00:01:07.000Z',
          lineage: fixture.lineage,
          reconnectKey: fixture.reconnectKey,
          sandboxBindingRef: `lease-binding:${leaseId}`,
          workerSequence: 2,
        })
      ).toMatchObject({ recoveryState: null, status: 'active' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('uses existing cleanup when read-only backend restoration fails before arming', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      prepareReconnectLease(coreDb, 'restore_failure');
      await runRestartRecoveryThroughMaintenance(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        restoreBackendSession: async () => {
          throw new Error('The durable backend identity cannot be restored.');
        },
      });

      expect(cleanupCalls).toBe(1);
      expect(requireSchedulerSessionLease(coreDb, 'lease_restore_failure')).toMatchObject({
        recoveryDeadline: null,
        recoveryState: null,
        status: 'failed',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('adopts only the original process at the exact next sequence', async () => {
    const coreDb = createMigratedCoreDb();

    try {
      const fixture = prepareReconnectLease(coreDb, 'exact_reconnect');
      await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        restoreBackendSession: async () => {},
      });
      const armed = requireSchedulerSessionLease(coreDb, 'lease_exact_reconnect');

      const adopted = adoptSchedulerLeaseReconnect(coreDb, {
        acceptedAt: '2026-07-05T00:01:01.000Z',
        lineage: fixture.lineage,
        reconnectKey: fixture.reconnectKey,
        sandboxBindingRef: 'lease-binding:lease_exact_reconnect',
        workerSequence: 2,
      });

      expect(adopted).toMatchObject({
        heartbeatDeadline: armed.recoveryDeadline,
        lastWorkerSequence: 1,
        recoveryDeadline: null,
        recoveryState: null,
      });
      expect(
        acceptSchedulerLeaseHeartbeatByBinding(coreDb, {
          acceptedAt: '2026-07-05T00:01:01.000Z',
          lineage: fixture.lineage,
          sandboxBindingRef: 'lease-binding:lease_exact_reconnect',
          workerSequence: 2,
        })
      ).toMatchObject({ lastWorkerSequence: 2, status: 'active' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'key',
    'lineage',
    'sequence',
    'deadline',
  ] as const)('rejects reconnect when %s does not match the armed lease', async (mismatch) => {
    const coreDb = createMigratedCoreDb();

    try {
      const suffix = `reject_${mismatch}`;
      const fixture = prepareReconnectLease(coreDb, suffix);
      await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        restoreBackendSession: async () => {},
      });
      const armed = requireSchedulerSessionLease(coreDb, `lease_${suffix}`);
      const lineage =
        mismatch === 'lineage'
          ? { ...fixture.lineage, turnId: 'turn_from_another_worker' }
          : fixture.lineage;

      expect(() =>
        adoptSchedulerLeaseReconnect(coreDb, {
          acceptedAt:
            mismatch === 'deadline'
              ? (armed.recoveryDeadline ?? '2026-07-05T00:01:00.000Z')
              : '2026-07-05T00:01:01.000Z',
          lineage,
          reconnectKey:
            mismatch === 'key' ? reconnectKeyFor('wrong-process') : fixture.reconnectKey,
          sandboxBindingRef: `lease-binding:lease_${suffix}`,
          workerSequence: mismatch === 'sequence' ? 3 : 2,
        })
      ).toThrow();
      expect(requireSchedulerSessionLease(coreDb, `lease_${suffix}`)).toMatchObject({
        lastWorkerSequence: 1,
        recoveryDeadline: armed.recoveryDeadline,
        recoveryState: 'awaiting-reconnect',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reuses the existing cleanup path once after the reconnect deadline', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;

    try {
      prepareReconnectLease(coreDb, 'reconnect_timeout');
      const recovery = await runSchedulerRestartRecovery(coreDb, {
        now: () => '2026-07-05T00:01:00.000Z',
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
        restoreBackendSession: async () => {},
      });
      const deadline = requireSchedulerSessionLease(
        coreDb,
        'lease_reconnect_timeout'
      ).recoveryDeadline;
      if (!deadline) {
        throw new Error('Restart recovery did not arm a reconnect deadline.');
      }

      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
          expect(
            requireSchedulerSessionLease(coreDb, 'lease_reconnect_timeout').recoveryState
          ).toBe('needs-evidence');
        },
        now: () => deadline,
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });
      await runSchedulerRecoveryMaintenance(coreDb, recovery.schedulerEpoch, {
        cleanupBackendSession: async () => {
          throw new Error('Expired reconnect cleanup must not run twice.');
        },
        now: () => new Date(Date.parse(deadline) + 1).toISOString(),
        projectRecoveredTurn: async () => ({ status: 'failed' as const }),
      });

      expect(cleanupCalls).toBe(1);
      expect(getWorkerBackendSession(coreDb, 'lease_reconnect_timeout')).toMatchObject({
        state: 'cleaned',
      });
      expect(requireSchedulerSessionLease(coreDb, 'lease_reconnect_timeout')).toMatchObject({
        status: 'failed',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'cleanup-pending',
    'physical-cleaned',
    'cleaned',
  ] as const)('defers %s to a live lifecycle owner and resumes recovery after it exits', async (state) => {
    const coreDb = createMigratedCoreDb();
    const suffix = `live_owner_${state}`;
    const leaseId = `lease_${suffix}`;
    let active = true;
    const cleanupBackendSession = vi.fn(async () => {});
    const projectRecoveredTurn = vi.fn(async () => ({ status: 'completed' as const }));
    try {
      dispatchLease(coreDb, suffix);
      recordBackendSession(coreDb, suffix, state);
      markWorkerBackendWorkspaceHandoffComplete(coreDb, { leaseId });
      markSchedulerSessionLeaseReleasing(coreDb, { leaseId, releaseReason: 'worker-final-status' });
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-05T00:00:07.000Z',
        lineage: {
          agentSessionId: `as_${suffix}`,
          packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
          requestId: `request_${suffix}`,
          threadId: `thread_${suffix}`,
          turnId: `turn_${suffix}`,
          workspaceId: 'ws_demo',
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sandboxBindingRef: `lease-binding:lease_${suffix}`,
        sequence: 1,
      });
      const original = getWorkerBackendSession(coreDb, leaseId);
      const input: RunSchedulerRestartRecoveryInput = {
        cleanupBackendSession,
        isTurnExecutionActive: (turnId) => active && turnId === `turn_${suffix}`,
        projectRecoveredTurn,
      };
      await runSchedulerRecoveryMaintenance(coreDb, 7, input);
      expect(getWorkerBackendSession(coreDb, leaseId)).toEqual(original);
      expect(requireSchedulerSessionLease(coreDb, leaseId).status).toBe('releasing');
      expect(cleanupBackendSession).not.toHaveBeenCalled();
      expect(projectRecoveredTurn).not.toHaveBeenCalled();
      active = false;
      await runSchedulerRecoveryMaintenance(coreDb, 7, input);
      expect(cleanupBackendSession).toHaveBeenCalledTimes(state === 'cleanup-pending' ? 1 : 0);
      expect(projectRecoveredTurn).toHaveBeenCalledTimes(1);
      expect(getWorkerBackendSession(coreDb, leaseId)?.state).toBe('cleaned');
      expect(requireSchedulerSessionLease(coreDb, leaseId).status).toBe('released');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed instead of replaying an accepted completed final-status closeout', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;
    let closeoutCalls = 0;
    let fallbackProjectionCalls = 0;
    let preparedIdentity:
      | Parameters<NonNullable<RunSchedulerRestartRecoveryInput['prepareBackendCleanup']>>[0]
      | null = null;

    try {
      const suffix = 'accepted_final_status';
      const fixture = prepareReconnectLease(coreDb, suffix);
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:06.000Z',
        releaseReason: 'worker-final-status',
      });
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-05T00:00:07.000Z',
        lineage: fixture.lineage,
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sandboxBindingRef: `lease-binding:lease_${suffix}`,
        sequence: 1,
      });
      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        prepareBackendCleanup: (identity) => {
          preparedIdentity = identity;
        },
        projectRecoveredTurn: async (session) => {
          fallbackProjectionCalls += 1;
          expect(session).toMatchObject({
            agentSessionId: `as_${suffix}`,
            leaseId: `lease_${suffix}`,
            packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
            threadId: `thread_${suffix}`,
            turnId: `turn_${suffix}`,
            workspaceId: 'ws_demo',
          });
          return { status: 'failed' as const };
        },
        reconcileAcceptedFinalStatus: async () => {
          closeoutCalls += 1;
          return { status: 'completed' as const };
        },
      });

      expect({ cleanupCalls, closeoutCalls, fallbackProjectionCalls }).toEqual({
        cleanupCalls: 0,
        closeoutCalls: 0,
        fallbackProjectionCalls: 1,
      });
      expect(preparedIdentity).toMatchObject({
        agentSessionId: `as_${suffix}`,
        backendSessionId: testNanoHostBackendSessionId(suffix),
        packageSnapshotId: `aepsnap_turn_${suffix}_as_${suffix}`,
        runtimeTargetId: 'runtime-target-test',
      });
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(requireSchedulerSessionLease(coreDb, `lease_${suffix}`)).toMatchObject({
        recoveryState: null,
        status: 'releasing',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed instead of replaying an accepted ask-user final-status closeout', async () => {
    const coreDb = createMigratedCoreDb();
    let cleanupCalls = 0;
    let closeoutCalls = 0;
    let fallbackProjectionCalls = 0;

    try {
      const suffix = 'accepted_ask_user';
      const fixture = prepareReconnectLease(coreDb, suffix);
      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId: `lease_${suffix}`,
        now: () => '2026-07-05T00:00:06.000Z',
        releaseReason: 'worker-final-status',
      });
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-05T00:00:07.000Z',
        lineage: fixture.lineage,
        operation: 'final_status',
        record: { sequence: 1, status: 'blocked', stopReason: 'ask_user' },
        recordKey: '1',
        sandboxBindingRef: `lease-binding:lease_${suffix}`,
        sequence: 1,
      });

      await runSchedulerRestartRecovery(coreDb, {
        cleanupBackendSession: async () => {
          cleanupCalls += 1;
        },
        now: () => '2026-07-05T00:01:00.000Z',
        prepareBackendCleanup: () => undefined,
        projectRecoveredTurn: async () => {
          fallbackProjectionCalls += 1;
          return { status: 'failed' as const };
        },
        reconcileAcceptedFinalStatus: async () => {
          closeoutCalls += 1;
          return { status: 'interrupted' as const };
        },
      });

      expect({ cleanupCalls, closeoutCalls, fallbackProjectionCalls }).toEqual({
        cleanupCalls: 0,
        closeoutCalls: 0,
        fallbackProjectionCalls: 1,
      });
      expect(getWorkerBackendSession(coreDb, `lease_${suffix}`)).toMatchObject({
        state: 'cleanup-pending',
      });
      expect(requireSchedulerSessionLease(coreDb, `lease_${suffix}`)).toMatchObject({
        recoveryState: null,
        status: 'releasing',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT in_use_count AS inUseCount FROM scheduler_capacity_records')
          .get()
      ).toEqual({ inUseCount: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
