import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { FsStore } from '../lib/store.js';
import {
  createSchedulerExecutionAttempt,
  markSchedulerExecutionAttemptClosing,
} from '../runtime/execution-attempt-records.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { observeAppUpdatePreflight } from './preflight.js';

describe('content-free deployment maintenance preflight', () => {
  it('counts pending, queued, open, closing and in-flight owners independently, excluding denied work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-preflight-owners-'));
    const coreDb = openCoreDb(root);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(root);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: root });
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Private pending work',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Private pending prompt',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { status: 'pending' }
    );
    const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
    inflightCommands.set(
      store,
      new Map([['private-key', { inputHash: 'private-hash', promise: new Promise(() => {}) }]])
    );
    for (const phase of ['queued', 'open', 'closing', 'denied'] as const) {
      const executionThread = await store.createThread(
        'ws_00000000-0000-7000-8000-000000000001',
        `Private queue ${phase}`
      );
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue_${phase}`,
        requestId: `req_${phase}`,
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: executionThread.id,
        turnId: testEntityId('tu', `turn_${phase}`),
        inputRef: schedulerFixtureInput(
          'ws_00000000-0000-7000-8000-000000000001',
          testEntityId('tu', `turn_${phase}`),
          'Private admitted input'
        ),
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
      });
      if (phase === 'denied')
        denySchedulerAdmissionEntry(coreDb, {
          queueEntryId: entry.queueEntryId,
          denialReason: 'authority-denied',
        });
      if (phase === 'open' || phase === 'closing') {
        const attempt = createSchedulerExecutionAttempt(coreDb, {
          entry,
          preparationInput: { private: 'preparation' },
        });
        if (phase === 'closing')
          markSchedulerExecutionAttemptClosing(coreDb, {
            attemptId: attempt.attemptId,
            cause: 'test-closing',
          });
      }
    }
    const result = observeAppUpdatePreflight({ coreDb, store, inflightCommands });
    expect(result.counts).toEqual({
      runningTurns: 0,
      pendingTurns: 1,
      queuedAdmissions: 1,
      openAttempts: 1,
      closingAttempts: 1,
      inFlightCommands: 1,
    });
    expect(result.state).toBe('busy');
    expect(JSON.stringify(result)).not.toMatch(/Private|private|queue_|req_|turn_/);
  });

  it.each([
    {
      phase: 'closing',
      recoveryState: 'needs-evidence',
      state: 'idle',
      running: 0,
      open: 0,
      closing: 0,
    },
    { phase: 'closing', recoveryState: null, state: 'busy', running: 1, open: 0, closing: 1 },
    {
      phase: 'open',
      recoveryState: 'needs-evidence',
      state: 'busy',
      running: 1,
      open: 1,
      closing: 0,
    },
    {
      phase: 'open',
      recoveryState: 'awaiting-reconnect',
      state: 'busy',
      running: 1,
      open: 1,
      closing: 0,
    },
  ])(
    'FS-CORE T2a update observation for $phase/$recoveryState is $state',
    async ({ phase, recoveryState, state, running, open, closing }) => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-preflight-held-'));
      const coreDb = openCoreDb(root);
      onTestFinished(async () => {
        await shutdownControlStoreWorkerClient();
        closeWorkspaceProductReadHandles(root);
        if (coreDb.sqlite.open) coreDb.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      });
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const store = await createDemoStore({ dataRoot: root });
      const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
      const userId = 'usr_00000000-0000-7000-8000-000000000001';
      recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
      const thread = await store.createThread(workspaceId, 'Held worker');
      const turn = await store.createTurn(workspaceId, thread.id, 'Authorized work', {
        kind: 'user',
        id: userId,
      });
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'held-queue',
        requestId: 'held-request',
        triggerActor: turn.triggerActor,
        workspaceId,
        threadId: thread.id,
        turnId: turn.id,
        inputRef: schedulerFixtureInput(workspaceId, turn.id, 'Authorized work'),
        requestedAgentId: 'agent_codex_host',
      });
      const attempt = createSchedulerExecutionAttempt(coreDb, { entry, preparationInput: {} });
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_execution_attempts SET phase=?, recovery_state=? WHERE attempt_id=?'
        )
        .run(phase, recoveryState, attempt.attemptId);
      expect(
        observeAppUpdatePreflight({ coreDb, store, inflightCommands: new WeakMap() })
      ).toMatchObject({
        state,
        counts: {
          runningTurns: running,
          pendingTurns: 0,
          queuedAdmissions: 0,
          openAttempts: open,
          closingAttempts: closing,
          inFlightCommands: 0,
        },
      });
      expect(store.getTurnById(turn.id).status).toBe('running');
    }
  );

  it('counts active private work and emits only the exact aggregate shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-preflight-'));
    const coreDb = openCoreDb(root);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(root);
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: root });
    const thread = await store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Private title must stay private',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      thread.id,
      'Private prompt must stay private',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const app = createApp({ store, coreDb, dataRoot: root });
    const response = await app.request('/api/app/operations/app-update.preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      observedAt: expect.any(String),
      workspaceCount: store.listWorkspaces().length,
      state: 'busy',
      counts: {
        runningTurns: 1,
        pendingTurns: 0,
        queuedAdmissions: 0,
        openAttempts: 0,
        closingAttempts: 0,
        inFlightCommands: 0,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/Private|ws_demo|user_local/);
  });

  it('reports unavailable storage rather than inventing an idle queue', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'preflight-store-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(storeRoot);
      rmSync(storeRoot, { recursive: true, force: true });
    });
    const fixtureStore = createTestStore({ dataRoot: storeRoot });
    const app = createApp({ store: fixtureStore });
    const response = await app.request('/api/app/operations/app-update.preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'app_update_unavailable' });
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
