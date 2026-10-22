import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AdmitExternalTriggerResponseSchema } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBetterAuth } from '../auth/better-auth.js';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { AutomationStore } from '../lib/automation-store.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  cancelSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { isControlWorkerRequest } from '../storage/control-store-worker-protocol.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { findExternalTriggerAdmission } from '../storage/external-trigger-admissions.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  getWorkspaceMember,
  getWorkspaceRegistryFact,
  removeWorkspaceMember,
  transferWorkspaceOwnership,
} from '../workspace-sharing.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  admitExternalTriggerEvent,
  type ExternalTriggerServiceInput,
} from './external-trigger-service.js';
import { inspectExternalTriggerAdmission } from './external-trigger-source.js';
import { dispatchOpenkitWorkTool } from './openkit-work-mcp.js';
import type { TurnExecutor } from './types.js';
import { prepareWorkerTurnJournalIntents } from './worker-governance-turn-executor.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';

// This suite decides source admission and durable publication only. Dispatch has its own real-owner suite.
vi.mock('./scheduler-dispatch-loop.js', () => ({
  getSchedulerPreparationClaims: () => new Map(),
  runSchedulerDispatchLoop: vi.fn(async () => ({ startedTurns: [] })),
}));

const owned: { root: string; db: CoreDb }[] = [];
afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
  vi.useRealTimers();
  await shutdownControlStoreWorkerClient();
  for (const { root, db } of owned.splice(0)) {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Uses real schedule, queue, canonical history and package-attempt lineage without a backend effect. */
async function fixture(options: { privateSource?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-18T00:00:00.000Z');
  const root = mkdtempSync(join(tmpdir(), 'external-trigger-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  owned.push({ root, db });
  const userId = ensureLocalUser(db);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('External events');
  let thread = await store.createThread(
    workspace.id,
    'Scheduled poll',
    undefined,
    'conversation',
    options.privateSource ? { visibility: 'private', privateOwnerUserId: userId } : undefined
  );
  recordWorkspaceOwnerMembership({ coreDb: db, workspaceId: workspace.id, ownerUserId: userId });
  const mutationAdmission = new WorkspaceMutationAdmission();
  let instant = '2026-10-18T00:00:00.000Z';
  const schedules = new AutomationStore(db, mutationAdmission, () => instant);
  const agentSetup = createTestAgentSetup();
  const manifest = agentSetup.manifest;
  const created = schedules.createAutomation(userId, {
    name: 'Poll',
    workspaceId: workspace.id,
    threadId: thread.id,
    intervalSeconds: 5,
    prompt: 'Read new events',
    agentId: manifest.id,
  });
  const schedule = schedules.updateAutomation(userId, created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: instant,
  });
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    agentManifests: [manifest],
    dataRoot: null,
    gatewayConfig: createTestGatewayConfig(),
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Fixture',
        kind: 'local',
        defaultModel: 'openai/gpt-5.2',
        models: ['openai/gpt-5.2'],
        modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
      },
    ]),
  });
  async function poll() {
    const occurrence = schedules.collectScanCandidates(instant)[0]!;
    const accepted = schedules.commitAttempt(occurrence.id, occurrence.definitionRevision, {
      kind: 'ready',
      payload: {
        backendId: 'test-backend',
        requestedAgentId: manifest.id,
        profileRef: null,
        modelId: 'openai/gpt-5.2',
        workspaceCwd: null,
        workspaceRoots: [],
      },
    })!;
    const entry = requireSchedulerAdmissionEntry(db, accepted.queueEntryId!);
    const agentSessionId = allocateEntityId('as');
    await store.createAgentSession({
      id: agentSessionId,
      agentId: manifest.id,
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: instant,
      updatedAt: instant,
    });
    const turn = await store.createTurn(
      workspace.id,
      thread.id,
      entry.turnInput,
      schedule.actor,
      snapshot.version,
      {
        turnId: entry.turnId,
        status: 'running',
        agentId: manifest.id,
        agentSessionId,
        executorKind: 'worker',
      }
    );
    const environmentPackage = resolveAgentEnvironmentPackage({
      coreDb: db,
      agentSetup,
      agentSessionId,
      triggerActor: schedule.actor,
      userId,
      backend: { kind: 'openshell' },
      createdAt: instant,
      requestId: 'req_external_poll',
      turn,
      workspaceCwd: '/workspace/output',
      workspaceRoots: [],
    });
    const packageSnapshotId = environmentPackage.snapshotId;
    const attempt = recordTestExecutionAttempt(db, {
      entry,
      attemptId: testEntityId('attempt', entry.turnId),
      agentSessionId,
      inputRef: packageSnapshotId,
      bindingRef: `binding:${entry.turnId}`,
      sessionCompatibilityKey: 'sha256:fixture',
      now: () => instant,
    });
    const ws = openWorkspaceDb(root, workspace.id);
    try {
      recordAgentEnvironmentPackageSnapshot(ws, { environmentPackage, createdAt: instant });
      await store.updateAgentSession(agentSessionId, {
        environmentPackageSnapshotId: packageSnapshotId,
      });
      // Admit original obligations before this source can request an outside effect.
      const journalIntents = prepareWorkerTurnJournalIntents(ws, environmentPackage, attempt, null);
      await store.updateTurn(entry.turnId, { agentSessionId }, { journalIntents });
    } finally {
      ws.sqlite.close();
    }
    return {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: entry.turnId,
      agentSessionId,
      packageSnapshotId,
      triggerActor: schedule.actor,
      environmentPackage,
    };
  }
  const source = await poll();
  const dependencies: ExternalTriggerServiceInput = {
    schedules,
    store,
    snapshot,
    source,
    workerPlacement: 'local',
    providerCredentialResolver: () => null,
    turnExecutor: { executionBackend: { id: 'test-backend' } } as TurnExecutor,
    eventKey: 'mail:message-1',
    input: 'Handle this one message only.',
  };
  const admit = (overrides: Partial<ExternalTriggerServiceInput> = {}) =>
    admitExternalTriggerEvent({ ...dependencies, ...overrides });
  return {
    root,
    db,
    userId,
    store,
    schedules,
    schedule,
    source,
    dependencies,
    admit,
    nextPoll: async () => {
      // A paused target edit admits another real poll without inventing completion of the first.
      const paused = schedules.updateAutomation(userId, schedule.id, {
        expectedRevision: schedules.getAutomation(schedule.id).revision,
        status: 'paused',
      });
      thread = await store.createThread(workspace.id, 'Later scheduled poll');
      const edited = schedules.updateAutomation(userId, schedule.id, {
        expectedRevision: paused.revision,
        threadId: thread.id,
      });
      instant = '2026-10-26T00:00:00.000Z';
      vi.setSystemTime(instant);
      schedules.updateAutomation(userId, schedule.id, {
        expectedRevision: edited.revision,
        status: 'active',
        scheduledAt: instant,
      });
      return await poll();
    },
  };
}

function queueCount(db: CoreDb): number {
  return (
    db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get() as {
      n: number;
    }
  ).n;
}

describe('bounded scheduled poll event admission', () => {
  it.each([
    'acknowledged',
    'revoked-source',
    'lost-ack',
  ] as const)('retains original event work across initial native publication: %s', async (outcome) => {
    const f = await fixture();
    const duplicateSource = await f.nextPoll();
    const before = queueCount(f.db);
    const createTurn = vi.spyOn(f.store, 'createTurn');
    // Hold the actual native reply after COMMIT; admission and SQL remain unchanged.
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held: { id?: number; worker?: Worker; deliver?: () => void } = {};
    const post = Worker.prototype.postMessage;
    const emit = Worker.prototype.emit;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, ...args) {
      const request: unknown = args[0];
      if (
        held.id === undefined &&
        isControlWorkerRequest(request) &&
        request.operation === 'products' &&
        request.transition.products.some(
          (product) => product.kind === 'turn' && product.expectedRevision === 0
        )
      ) {
        held.id = request.id;
        held.worker = this;
      }
      return post.apply(this, args);
    });
    vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event, ...args) {
      const reply = args[0];
      if (
        this === held.worker &&
        event === 'message' &&
        typeof reply === 'object' &&
        reply !== null &&
        'id' in reply &&
        reply.id === held.id
      ) {
        held.deliver = () => {
          emit.call(this, event, ...args);
        };
        entered();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    let originalSettled = false;
    let duplicateSettled = false;
    let duplicate: Promise<PromiseSettledResult<Awaited<ReturnType<typeof f.admit>>>> | undefined;
    const original = Promise.allSettled([f.admit()]).then((results) => {
      originalSettled = true;
      return results[0]!;
    });
    try {
      await reached;
      const accepted = findExternalTriggerAdmission(f.db, f.schedule.id, f.dependencies.eventKey)!;
      const entry = requireSchedulerAdmissionEntry(f.db, accepted.queueEntryId);
      duplicate = Promise.allSettled([
        f.admit({
          source: duplicateSource,
          input: 'Changed content must not replace the original brief.',
        }),
      ]).then((results) => {
        duplicateSettled = true;
        return results[0]!;
      });
      // A real independent admission establishes progress without a guessed timer delay.
      const distinct = await f.admit({
        eventKey: 'mail:independent',
        input: 'Handle another event.',
      });
      expect(originalSettled).toBe(false);
      expect(duplicateSettled).toBe(false);
      expect(distinct.entry.threadId).not.toBe(entry.threadId);
      expect(distinct.entry.turnId).not.toBe(entry.turnId);
      if (outcome === 'revoked-source')
        f.store.setWorkspaceResourcePolicyProjection(() =>
          managedThreadPolicy({
            workspaceId: f.schedule.workspaceId,
            threadId: duplicateSource.threadId,
            userId: f.userId,
          })
        );
      if (outcome === 'lost-ack') {
        held.deliver = undefined;
        await held.worker!.terminate();
      } else {
        held.deliver?.();
        held.deliver = undefined;
      }
      const [first, repeated] = await Promise.all([original, duplicate]);
      if (outcome !== 'lost-ack') expect(first.status).toBe('fulfilled');
      if (outcome === 'revoked-source')
        expect(repeated).toMatchObject({
          status: 'rejected',
          reason: { code: 'external_event_denied' },
        });
      else if (outcome === 'acknowledged') {
        expect(repeated).toEqual({
          status: 'fulfilled',
          value: {
            ...(first as PromiseFulfilledResult<Awaited<ReturnType<typeof f.admit>>>).value,
            duplicate: true,
          },
        });
      }
      if (outcome === 'lost-ack') {
        // A valid committed tuple can be inspected; reply loss alone does not prove damage.
        for (const result of [first, repeated]) {
          if (result.status === 'rejected')
            expect(result.reason).toMatchObject({ code: 'recovery_required' });
          else {
            expect(result.value.admission).toEqual(accepted);
            expect(result.value.entry).toEqual(entry);
          }
        }
        await shutdownControlStoreWorkerClient();
      }
      const replay = await f.admit({ input: 'No replacement after publication uncertainty.' });
      expect(replay.admission).toEqual(accepted);
      expect(replay.entry).toEqual(entry);
      expect(replay.entry.turnInput).toBe(f.dependencies.input);
      expect(replay.admission.sourceTurnId).toBe(f.source.turnId);
      expect(replay.turn.status).toBe('pending');
      expect(replay.turn.agentSessionId ?? null).toBeNull();
      expect(createTurn).toHaveBeenCalledTimes(2);
      expect(queueCount(f.db)).toBe(before + 2);
    } finally {
      held.deliver?.();
      held.deliver = undefined;
      await Promise.all([original, duplicate]);
    }
  });

  it('joins the native Work Tool to isolated admission and refuses substituted scope and human entry', async () => {
    const f = await fixture();
    const workspaceDb = openWorkspaceDb(f.root, f.source.workspaceId);
    applyScopedMigrations(workspaceDb);
    try {
      const services = {
        coreDb: f.db,
        inflightCommands: new WeakMap(),
        runtimeConfig: () => f.dependencies.snapshot,
        turnExecutor: f.dependencies.turnExecutor,
        providerCredentialResolver: f.dependencies.providerCredentialResolver,
        workerPlacement: f.dependencies.workerPlacement,
      };
      const input = {
        coreDb: f.db,
        store: f.store,
        workspaceDb,
        environmentPackage: f.source.environmentPackage,
        automationStore: f.schedules,
        turnStartServices: services,
        knowledgeCallId: 'capability-event-1',
      };
      const args = { eventKey: 'email/native-1', input: 'Handle only the selected application.' };
      const call = async (arguments_: Record<string, unknown>) => {
        const result = await dispatchOpenkitWorkTool(input, 'automation_event-admit', arguments_);
        return AdmitExternalTriggerResponseSchema.parse(
          'structuredContent' in result ? result.structuredContent : undefined
        );
      };
      const first = await call(args);
      const second = await call({
        ...args,
        eventKey: 'email/native-2',
      });
      const replay = await call(args);
      expect(first).toMatchObject({
        scheduleId: f.schedule.id,
        sourceTurnId: f.source.turnId,
        duplicate: false,
      });
      expect(f.store.getTurnById(first.turnId).triggerSource).toEqual({
        kind: 'automation',
        summary: 'Scheduled event admission.',
      });
      expect(second.threadId).not.toBe(first.threadId);
      expect(replay).toEqual({ ...first, duplicate: true });
      await expect(
        dispatchOpenkitWorkTool(input, 'automation_event-admit', {
          ...args,
          threadId: second.threadId,
        })
      ).rejects.toMatchObject({ code: 'bound_input_conflict' });
      const invoke = createOperationInvocation({
        coreDb: f.db,
        store: f.store,
        automationStore: f.schedules,
        turnStartServices: services,
        workspaceMutationAdmission: f.schedules.mutationAdmission,
      });
      await expect(
        invoke(
          'automation.event-admit',
          {
            ...args,
            workspaceId: f.source.workspaceId,
            threadId: f.source.threadId,
            turnId: f.source.turnId,
          },
          { kind: 'public', actor: { kind: 'local', userId: f.userId } }
        )
      ).rejects.toMatchObject({
        code: 'workspace_access_denied',
      });
      expect(queueCount(f.db)).toBe(3);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('refuses a managed poll brief before publishing an unmanaged child despite current source grants', async () => {
    const f = await fixture();
    const agentId = f.store.getAgentSession(f.source.agentSessionId).agentId;
    const policy = managedThreadPolicy({
      workspaceId: f.source.workspaceId,
      threadId: f.source.threadId,
      userId: f.userId,
      operations: ['thread.read', 'turn.run'],
    });
    const permission = policy.statements.find((statement) => statement.kind === 'permission')!;
    policy.statements.push({
      ...permission,
      id: `${permission.id}-agent`,
      grant: { kind: 'agent-process', agentId },
    });
    f.store.setWorkspaceResourcePolicyProjection(() => policy);
    const workspaceDb = openWorkspaceDb(f.root, f.source.workspaceId);
    applyScopedMigrations(workspaceDb);
    try {
      const createThread = vi.spyOn(f.store, 'createThread');
      await expect(
        dispatchOpenkitWorkTool(
          {
            coreDb: f.db,
            store: f.store,
            workspaceDb,
            environmentPackage: f.source.environmentPackage,
            automationStore: f.schedules,
            turnStartServices: {
              coreDb: f.db,
              inflightCommands: new WeakMap(),
              runtimeConfig: () => f.dependencies.snapshot,
              turnExecutor: f.dependencies.turnExecutor,
              providerCredentialResolver: f.dependencies.providerCredentialResolver,
              workerPlacement: f.dependencies.workerPlacement,
            },
            knowledgeCallId: 'capability-managed-event',
          },
          'automation_event-admit',
          { eventKey: 'mail:protected', input: 'Handle the confidential acquisition case.' }
        )
      ).rejects.toMatchObject({ code: 'external_event_denied' });
      expect(createThread).not.toHaveBeenCalled();
      expect(findExternalTriggerAdmission(f.db, f.schedule.id, 'mail:protected')).toBeNull();
      expect(queueCount(f.db)).toBe(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('isolates two events in fresh shared child Threads while the first case is pending', async () => {
    const f = await fixture();
    const [first, replay] = await Promise.all([
      f.admit(),
      f.admit({ input: 'Concurrent changed source content' }),
    ]);
    expect(replay.admission).toEqual(first.admission);
    expect([first.duplicate, replay.duplicate].sort()).toEqual([false, true]);
    const second = await f.admit({
      eventKey: 'mail:message-2',
      input: 'Handle the second message.',
    });
    expect(replay.entry.turnInput).toBe(first.entry.turnInput);
    expect(second.entry.threadId).not.toBe(first.entry.threadId);
    expect(second.entry.turnId).not.toBe(first.entry.turnId);
    for (const result of [first, second]) {
      expect(f.store.getThread(f.schedule.workspaceId, result.entry.threadId)).toMatchObject({
        visibility: 'workspace',
        threadSource: 'worker',
        parentThreadId: f.source.threadId,
      });
      expect(result.entry.workerStorageChoice).toEqual({
        kind: 'fresh',
        goalId: null,
        taskId: null,
      });
      expect(result.turn.agentSessionId ?? null).toBeNull();
      expect(result.turn.items).toEqual([]);
      expect(result.entry.triggerActor).toEqual(f.schedule.actor);
      expect(result.admission.sourceTurnId).toBe(f.source.turnId);
    }
    expect(first.entry.turnInput).toBe(
      first.duplicate ? 'Concurrent changed source content' : f.dependencies.input
    );
    expect(queueCount(f.db)).toBe(3);
  });

  it('returns immutable original work after a later retargeted poll, Store/SQLite reopen and command receipt expiry', async () => {
    const f = await fixture();
    const first = await f.admit();
    const source = await f.nextPoll();
    const sourceRow = f.db.sqlite
      .prepare(
        'SELECT enqueued_at AS enqueuedAt FROM scheduler_admission_entries WHERE turn_id = ?'
      )
      .get(source.turnId) as { enqueuedAt: string };
    // The next authorized poll is later than the ordinary seven-day command receipt window.
    expect(Date.parse(sourceRow.enqueuedAt) - Date.parse(first.entry.enqueuedAt)).toBeGreaterThan(
      7 * 24 * 60 * 60 * 1000
    );
    const createThread = vi.spyOn(f.store, 'createThread');
    const duplicate = await f.admit({
      source,
      input: 'Changed external content must not replace the brief.',
      snapshot: { ...f.dependencies.snapshot, agentManifests: [] },
    });
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(createThread).not.toHaveBeenCalled();
    f.db.sqlite.close();
    const db = openCoreDb(f.root);
    owned.find((entry) => entry.root === f.root)!.db = db;
    applyMigrations(db);
    const store = new FsStore({ dataRoot: f.root });
    const schedules = new AutomationStore(db, new WorkspaceMutationAdmission());
    const again = await f.admit({ schedules, store, source, input: 'Still the same event' });
    expect(again.admission).toEqual(first.admission);
    expect(again.entry).toEqual(first.entry);
    expect(again.duplicate).toBe(true);
    expect(queueCount(db)).toBe(3);
  });

  it.each([
    'failed',
    'interrupted',
  ] as const)('never relaunches accepted %s work', async (status) => {
    const f = await fixture();
    const first = await f.admit();
    f.db.sqlite
      .prepare(
        "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ?"
      )
      .run(first.entry.queueEntryId);
    await f.store.updateTurn(first.turn.id, { status, completedAt: '2026-10-18T00:01:00.000Z' });
    const createTurn = vi.spyOn(f.store, 'createTurn');
    const repeated = await f.admit({ input: 'Try a replacement' });
    expect(repeated.turn.status).toBe(status);
    expect(repeated.admission).toEqual(first.admission);
    expect(createTurn).not.toHaveBeenCalled();
    expect(queueCount(f.db)).toBe(2);
  });

  it('accepts ordinary manifest-default reasoning effort without treating it as explicit queue input', async () => {
    const f = await fixture();
    const snapshot = {
      ...f.dependencies.snapshot,
      agentManifests: f.dependencies.snapshot.agentManifests.map((manifest) => ({
        ...manifest,
        models: { ...manifest.models, reasoningEffort: 'high' as const },
      })),
    };
    const first = await f.admit({ snapshot });
    expect(first.turn.reasoningEffort).toBe('high');
    expect(first.entry.reasoningEffort).toBeUndefined();
    expect((await f.admit()).admission).toEqual(first.admission);
  });

  it('retains accepted work with an unknown execution outcome without another admission', async () => {
    const f = await fixture();
    const first = await f.admit();
    const sessionId = allocateEntityId('as');
    await f.store.createAgentSession({
      id: sessionId,
      agentId: first.entry.requestedAgentId,
      workspaceId: first.entry.workspaceId,
      threadId: first.entry.threadId,
      status: 'busy',
      message: null,
      createdAt: '2026-10-18T00:00:01.000Z',
      updatedAt: '2026-10-18T00:00:01.000Z',
    });
    recordTestExecutionAttempt(f.db, {
      entry: first.entry,
      attemptId: testEntityId('attempt', first.turn.id),
      agentSessionId: sessionId,
      inputRef: 'snapshot_unknown_case',
      bindingRef: 'binding:unknown-case',
      sessionCompatibilityKey: 'sha256:fixture',
      operationId: 'unknown-case-operation',
      now: () => '2026-10-18T00:00:01.000Z',
    });
    await f.store.updateTurn(first.turn.id, { status: 'running', agentSessionId: sessionId });
    const createTurn = vi.spyOn(f.store, 'createTurn');
    expect((await f.admit()).admission).toEqual(first.admission);
    expect(createTurn).not.toHaveBeenCalled();
    expect(queueCount(f.db)).toBe(2);
  });

  it('returns recovery_required when the accepted queue is corrupt during publication failure handling', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'createTurn').mockImplementation(() => {
      f.db.sqlite
        .prepare(
          'UPDATE scheduler_admission_entries SET workspace_id = ? WHERE queue_entry_id IN (SELECT queue_entry_id FROM external_trigger_admissions)'
        )
        .run(allocateEntityId('ws'));
      throw new Error('injected accepted-history damage');
    });
    await expect(f.admit()).rejects.toMatchObject({ code: 'recovery_required' });
    const createThread = vi.spyOn(f.store, 'createThread');
    await expect(f.admit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(createThread).not.toHaveBeenCalled();
    expect(queueCount(f.db)).toBe(2);
  });

  it('rolls back both queue and join on insertion failure and permits a later ordinary admission', async () => {
    const f = await fixture();
    f.db.sqlite.exec(
      "CREATE TRIGGER reject_external BEFORE INSERT ON external_trigger_admissions BEGIN SELECT RAISE(ABORT, 'injected join refusal'); END"
    );
    await expect(f.admit()).rejects.toThrow('injected join refusal');
    expect(findExternalTriggerAdmission(f.db, f.schedule.id, f.dependencies.eventKey)).toBeNull();
    expect(queueCount(f.db)).toBe(1);
    f.db.sqlite.exec('DROP TRIGGER reject_external');
    const accepted = await f.admit();
    expect(accepted.duplicate).toBe(false);
    expect(queueCount(f.db)).toBe(2);
  });

  it('does not retry canonical publication after queue acceptance', async () => {
    const f = await fixture();
    const createTurn = vi.spyOn(f.store, 'createTurn').mockImplementation(() => {
      throw new Error('injected publication failure');
    });
    await expect(f.admit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(
      findExternalTriggerAdmission(f.db, f.schedule.id, f.dependencies.eventKey)
    ).not.toBeNull();
    await expect(f.admit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(createTurn).toHaveBeenCalledTimes(1);
    expect(queueCount(f.db)).toBe(2);
  });

  it.each([
    'missing',
    'contradictory',
  ] as const)('requires inspection for %s canonical accepted work', async (damage) => {
    const f = await fixture();
    const first = await f.admit();
    if (damage === 'missing') {
      await shutdownControlStoreWorkerClient();
      const db = openWorkspaceDb(f.root, first.entry.workspaceId);
      try {
        // Deliberate canonical-history loss after acknowledged admission, never successful setup.
        db.sqlite.transaction(() => {
          db.sqlite
            .prepare('DELETE FROM control_product_entries WHERE turn_id = ?')
            .run(first.turn.id);
          expect(
            db.sqlite.prepare('DELETE FROM control_turns WHERE id = ?').run(first.turn.id).changes
          ).toBe(1);
        })();
      } finally {
        db.sqlite.close();
      }
    } else await f.store.updateTurn(first.turn.id, { agentId: 'other-agent' });
    const createTurn = vi.spyOn(f.store, 'createTurn');
    await expect(f.admit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(createTurn).not.toHaveBeenCalled();
    expect(queueCount(f.db)).toBe(2);
  });

  it('reads acknowledged canonical target history through an earlier Store', async () => {
    const f = await fixture();
    const first = await f.admit();
    const earlier = new FsStore({ dataRoot: f.root });
    cancelSchedulerAdmissionEntry(f.db, first.entry);
    await f.store.updateTurn(first.turn.id, {
      status: 'interrupted',
      completedAt: '2026-10-18T00:01:00.000Z',
    });
    expect(inspectExternalTriggerAdmission(f.db, earlier, first.admission).turn.status).toBe(
      'interrupted'
    );
  });

  it.each([
    'paused',
    'deleted',
    'disabled-user',
    'removed-member',
    'stale-package',
    'stale-session',
    'ended-turn',
    'different-actor',
    'missing-occurrence',
    'private-source',
    'closed-workspace',
  ] as const)('refuses %s before event effects', async (reason) => {
    const f = await fixture({ privateSource: reason === 'private-source' });
    let source = f.source;
    if (reason === 'paused')
      f.schedules.updateAutomation(f.userId, f.schedule.id, {
        expectedRevision: f.schedule.revision,
        status: 'paused',
      });
    if (reason === 'deleted') f.schedules.deleteAutomation(f.userId, f.schedule.id);
    if (reason === 'disabled-user')
      f.db.sqlite.transaction(() => {
        expect(disableCanonicalUser(f.db, f.userId)?.changed).toBe(true);
      })();
    if (reason === 'removed-member') {
      // Transfer to a real active member before removing the unchanged poll principal.
      const email = `${randomUUID()}@example.invalid`;
      const { user } = await createBetterAuth(f.db, { env: {} }).api.signUpEmail({
        body: { name: 'Replacement owner', email, password: randomUUID() },
      });
      const removed = f.db.sqlite.transaction(() => {
        const scope = { coreDb: f.db, workspaceId: f.schedule.workspaceId };
        const invitation = createWorkspaceInvitation({
          ...scope,
          inviterUserId: f.userId,
          inviteeEmail: email,
        });
        if (invitation.kind !== 'created') throw new Error('Replacement invitation failed.');
        const accepted = acceptWorkspaceInvitation({
          ...scope,
          invitationId: invitation.invitation.invitationId,
          inviteeUserId: user.id,
          expectedRevision: invitation.invitation.revision,
        });
        if (accepted.kind !== 'accepted') throw new Error('Replacement membership failed.');
        const registry = getWorkspaceRegistryFact(f.db, scope.workspaceId);
        const member = getWorkspaceMember(f.db, scope.workspaceId, f.userId);
        if (!registry || !member) throw new Error('Original membership is missing.');
        const transfer = transferWorkspaceOwnership({
          ...scope,
          actorUserId: f.userId,
          targetUserId: user.id,
          expectedRegistryRevision: registry.registryRevision,
        });
        if (transfer.kind !== 'transferred') throw new Error('Owner transfer failed.');
        return removeWorkspaceMember({
          ...scope,
          actorUserId: user.id,
          memberUserId: f.userId,
          expectedRevision: member.revision,
        });
      })();
      if (
        removed.kind !== 'removed' ||
        removed.member.status !== 'removed' ||
        removed.member.userId !== f.userId
      )
        throw new Error('Poll principal membership was not removed.');
    }
    if (reason === 'stale-package') source = { ...source, packageSnapshotId: 'stale-package' };
    if (reason === 'stale-session') source = { ...source, agentSessionId: allocateEntityId('as') };
    if (reason === 'ended-turn')
      await terminalizeGovernedWorkerTurn({
        store: f.store,
        turnId: source.turnId,
        agentSessionId: source.agentSessionId,
        requestId: 'req_external_poll',
        outcome: 'interrupted',
        completedAt: '2026-10-18T00:01:00.000Z',
        errorCode: 'test_poll_interrupted',
        message: 'The source poll was interrupted before runtime submission.',
      });
    if (reason === 'different-actor')
      source = {
        ...source,
        triggerActor: { ...source.triggerActor, id: allocateEntityId('auto') },
      };
    if (reason === 'missing-occurrence')
      f.db.sqlite.prepare('DELETE FROM recurring_occurrences').run();
    if (reason === 'closed-workspace')
      await f.schedules.mutationAdmission.close(f.schedule.workspaceId);
    const createThread = vi.spyOn(f.store, 'createThread');
    await expect(f.admit({ source })).rejects.toMatchObject({ code: 'external_event_denied' });
    expect(createThread).not.toHaveBeenCalled();
    expect(queueCount(f.db)).toBe(1);
  });
});
