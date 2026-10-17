import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { AutomationStore } from '../lib/automation-store.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { findExternalTriggerAdmission } from '../storage/external-trigger-admissions.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { closeSchedulerExecutionAttemptWithoutEffects } from './execution-attempt-records.js';
import {
  admitExternalTriggerEvent,
  type ExternalTriggerServiceInput,
} from './external-trigger-service.js';
import { inspectExternalTriggerAdmission } from './external-trigger-source.js';
import type { TurnExecutor } from './types.js';

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
  for (const { root, db } of owned.splice(0)) {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Uses real schedule, queue, canonical history and package-attempt lineage without a backend effect. */
function fixture(options: { privateSource?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-18T00:00:00.000Z');
  const root = mkdtempSync(join(tmpdir(), 'external-trigger-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  owned.push({ root, db });
  const userId = ensureLocalUser(db);
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('External events');
  const thread = store.createThread(
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
  const manifest = createTestAgentSetup().manifest;
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
  function poll() {
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
    const packageSnapshotId = `snapshot_${entry.turnId}`;
    store.createAgentSession({
      id: agentSessionId,
      agentId: manifest.id,
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: instant,
      updatedAt: instant,
    });
    store.createTurn(workspace.id, thread.id, entry.turnInput, schedule.actor, snapshot.version, {
      turnId: entry.turnId,
      status: 'running',
      agentId: manifest.id,
      agentSessionId,
      executorKind: 'worker',
    });
    recordTestExecutionAttempt(db, {
      entry,
      attemptId: testEntityId('attempt', entry.turnId),
      agentSessionId,
      inputRef: packageSnapshotId,
      bindingRef: `binding:${entry.turnId}`,
      sessionCompatibilityKey: 'sha256:fixture',
      now: () => instant,
    });
    return {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: entry.turnId,
      agentSessionId,
      packageSnapshotId,
      triggerActor: schedule.actor,
    };
  }
  const source = poll();
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
    nextPoll: () => {
      store.updateTurn(source.turnId, { status: 'completed', completedAt: instant });
      store.updateAgentSession(source.agentSessionId, { status: 'failed', updatedAt: instant });
      closeSchedulerExecutionAttemptWithoutEffects(db, {
        attemptId: testEntityId('attempt', source.turnId),
        noOutstandingEffects: true,
        cause: 'fixture-read-only-poll',
        now: () => instant,
      });
      instant = '2026-10-26T00:00:00.000Z';
      vi.setSystemTime(instant);
      return poll();
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
  it('isolates two events in fresh shared child Threads while the first case is pending', async () => {
    const f = fixture();
    const [first, replay] = await Promise.all([
      f.admit(),
      f.admit({ input: 'Concurrent changed source content' }),
    ]);
    expect(replay.admission).toEqual(first.admission);
    expect(replay.duplicate).toBe(true);
    const second = await f.admit({
      eventKey: 'mail:message-2',
      input: 'Handle the second message.',
    });
    expect(first.duplicate).toBe(false);
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
    expect(first.entry.turnInput).toBe(f.dependencies.input);
    expect(queueCount(f.db)).toBe(3);
  });

  it('returns immutable original work after a later poll, Store/SQLite reopen and command receipt expiry', async () => {
    const f = fixture();
    const first = await f.admit();
    const source = f.nextPoll();
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
    const f = fixture();
    const first = await f.admit();
    f.db.sqlite
      .prepare(
        "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ?"
      )
      .run(first.entry.queueEntryId);
    f.store.updateTurn(first.turn.id, { status, completedAt: '2026-10-18T00:01:00.000Z' });
    const createTurn = vi.spyOn(f.store, 'createTurn');
    const repeated = await f.admit({ input: 'Try a replacement' });
    expect(repeated.turn.status).toBe(status);
    expect(repeated.admission).toEqual(first.admission);
    expect(createTurn).not.toHaveBeenCalled();
    expect(queueCount(f.db)).toBe(2);
  });

  it('accepts ordinary manifest-default reasoning effort without treating it as explicit queue input', async () => {
    const f = fixture();
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
    const f = fixture();
    const first = await f.admit();
    const sessionId = allocateEntityId('as');
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
    f.store.updateTurn(first.turn.id, { status: 'running', agentSessionId: sessionId });
    const createTurn = vi.spyOn(f.store, 'createTurn');
    expect((await f.admit()).admission).toEqual(first.admission);
    expect(createTurn).not.toHaveBeenCalled();
    expect(queueCount(f.db)).toBe(2);
  });

  it('returns recovery_required when the accepted queue is corrupt during publication failure handling', async () => {
    const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
    const first = await f.admit();
    const path = join(
      f.root,
      'workspaces',
      first.entry.workspaceId,
      'threads',
      first.entry.threadId,
      'turns',
      first.entry.turnId,
      'turn.json'
    );
    if (damage === 'missing') rmSync(path);
    else
      writeFileSync(
        path,
        JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), agentId: 'other-agent' })
      );
    const createTurn = vi.spyOn(f.store, 'createTurn');
    await expect(f.admit()).rejects.toMatchObject({ code: 'recovery_required' });
    expect(createTurn).not.toHaveBeenCalled();
    expect(queueCount(f.db)).toBe(2);
  });

  it('uses canonical target history when the derivative Store is stale', async () => {
    const f = fixture();
    const first = await f.admit();
    f.db.sqlite
      .prepare(
        "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ?"
      )
      .run(first.entry.queueEntryId);
    const path = join(
      f.root,
      'workspaces',
      first.entry.workspaceId,
      'threads',
      first.entry.threadId,
      'turns',
      first.entry.turnId,
      'turn.json'
    );
    writeFileSync(
      path,
      JSON.stringify({
        ...JSON.parse(readFileSync(path, 'utf8')),
        status: 'interrupted',
        completedAt: '2026-10-18T00:01:00.000Z',
      })
    );
    expect(f.store.getTurnById(first.turn.id).status).toBe('pending');
    expect(inspectExternalTriggerAdmission(f.db, f.store, first.admission).turn.status).toBe(
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
    const f = fixture({ privateSource: reason === 'private-source' });
    let source = f.source;
    if (reason === 'paused')
      f.schedules.updateAutomation(f.userId, f.schedule.id, {
        expectedRevision: f.schedule.revision,
        status: 'paused',
      });
    if (reason === 'deleted') f.schedules.deleteAutomation(f.userId, f.schedule.id);
    if (reason === 'disabled-user')
      f.db.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(f.userId);
    if (reason === 'removed-member') {
      const replacement = allocateEntityId('usr');
      const at = '2026-10-18T00:00:00.000Z';
      f.db.sqlite.transaction(() => {
        f.db.sqlite
          .prepare(
            "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES (?, 'Replacement', 'replacement@example.com', false, ?, ?, 'human')"
          )
          .run(replacement, Date.parse(at), Date.parse(at));
        f.db.sqlite
          .prepare(
            "INSERT INTO workspace_members (workspace_id,user_id,status,invitation_id,joined_at,removed_at,revision,created_at,updated_at) VALUES (?,?,'active',NULL,?,NULL,1,?,?)"
          )
          .run(f.schedule.workspaceId, replacement, at, at, at);
        f.db.sqlite
          .prepare(
            'UPDATE workspace_registry SET owner_user_id = ?, revision = revision + 1 WHERE workspace_id = ?'
          )
          .run(replacement, f.schedule.workspaceId);
        f.db.sqlite
          .prepare(
            "UPDATE workspace_members SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND user_id = ?"
          )
          .run(at, at, f.schedule.workspaceId, f.userId);
      })();
    }
    if (reason === 'stale-package') source = { ...source, packageSnapshotId: 'stale-package' };
    if (reason === 'stale-session') source = { ...source, agentSessionId: allocateEntityId('as') };
    if (reason === 'ended-turn')
      f.store.updateTurn(source.turnId, {
        status: 'completed',
        completedAt: '2026-10-18T00:01:00.000Z',
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
