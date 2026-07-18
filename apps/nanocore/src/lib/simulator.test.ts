import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import {
  ensureConfiguredSchedulerBaseline,
  upsertSchedulerCapacityRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { SimulatedTurnExecutor } from './simulator.js';

/**
 * Opens a migrated Core database for simulator route tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-simulator-route-')));

  applyMigrations(coreDb);
  configureLocalSchedulerCapacity(coreDb, 3);
  return coreDb;
}

/**
 * Configures local scheduler capacity for multi-turn simulator route tests.
 *
 * @param coreDb Migrated Core database handles.
 * @param capacity Concurrent local lease capacity.
 */
function configureLocalSchedulerCapacity(coreDb: CoreDb, capacity: number): void {
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
    maxConcurrentSessions: capacity,
    poolId: 'pool_local',
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: capacity,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: new Date().toISOString(),
    poolId: 'pool_local',
    queueDepth: 0,
    targetId: 'target_local',
  });
}

/**
 * Links a temporary repository resource for scheduler-backed turn starts.
 *
 * @param app NanoCore app under test.
 */
async function linkRepository(app: ReturnType<typeof createApp>): Promise<void> {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-simulator-repository-'));

  mkdirSync(join(repositoryPath, '.git'));
  await app.request('/api/app/workspaces/ws_demo/repositories/default', {
    method: 'PUT',
    body: JSON.stringify({
      displayName: 'Simulator repository',
      localPath: repositoryPath,
    }),
    headers: { 'content-type': 'application/json' },
  });
}

describe('SimulatedTurnExecutor', () => {
  afterEach(() => {
    delete process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
  });

  it('does not resume a scheduled worker after its approval Gate', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });

    try {
      await linkRepository(app);
      const turnResponse = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000211',
          input: 'Simulated scheduled worker run',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turn = (await turnResponse.json()) as { id: string };

      expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
      const storedTurn = store.getTurnById(turn.id);
      expect(storedTurn).toMatchObject({
        agentId: 'agent_codex_host',
        agentProfileId: 'default',
        agentSessionId: expect.stringMatching(/^as_/),
        status: 'awaiting_human',
        humanGate: {
          kind: 'approval',
          approvalRequestId: `ap_${turn.id}`,
          itemId: `it_approval_request_${turn.id}`,
        },
      });
      expect(executor.getAgentSession(store, 'ws_demo', 'th_demo').id).toBe(
        storedTurn.agentSessionId
      );

      const approvalResponse = await app.request(`/api/approvals/ap_${turn.id}/respond`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          requestId: '0190f4c8-0000-7000-8000-000000000221',
          decision: 'granted',
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(approvalResponse.status).toBe(409);
      await expect(approvalResponse.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(store.getTurnById(turn.id)).toMatchObject({
        status: 'awaiting_human',
        humanGate: { kind: 'approval', approvalRequestId: `ap_${turn.id}` },
      });
      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.turnId === turn.id)
          .map((item) => item.type)
      ).toEqual([
        'user-message',
        'assistant-message',
        'reasoning',
        'command-execution',
        'approval-request',
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('uses the agent already selected on the turn', async () => {
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const firstTurn = store.createTurn('ws_demo', 'th_demo', 'Use the default agent');

    store.updateTurn(firstTurn.id, { agentId: 'agent_codex_host' });
    await executor.startTurn(store, firstTurn.id, 'Use the default agent');
    const firstSession = store.getAgentSession(`session_sim_turn_${firstTurn.id}`);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use the selected agent');

    store.updateTurn(turn.id, { agentId: 'agent_opencode_host' });
    await executor.startTurn(store, turn.id, 'Use the selected agent');

    expect(store.getTurnById(turn.id)).toMatchObject({
      agentId: 'agent_opencode_host',
      agentProfileId: 'default',
      agentSessionId: `session_sim_turn_${turn.id}`,
    });
    expect(store.getAgentSession(firstSession.id).agentId).toBe('agent_codex_host');
    expect(store.getTurnById(firstTurn.id).agentSessionId).not.toBe(
      store.getTurnById(turn.id).agentSessionId
    );

    await executor.interruptTurn(store, turn.id);

    expect(executor.getAgentSession(store, 'ws_demo', 'th_demo').id).toBe(firstSession.id);
  });

  it('uses the simulator as the default executor when requested by environment', async () => {
    process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';

    const app = createApp();
    const response = await app.request('/api/meta');
    const meta = (await response.json()) as { itemTypes: string[] };

    expect(meta.itemTypes).toEqual(
      expect.arrayContaining(['reasoning', 'command-execution', 'user-input-request'])
    );
  });

  it('emits command output delta before the command item completes', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const app = createApp({ coreDb, store, turnExecutor: new SimulatedTurnExecutor() });

    try {
      await linkRepository(app);

      const turnResponse = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000240',
          input: 'Exercise simulated command output.',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turn = (await turnResponse.json()) as { id: string };
      const commandItemId = `it_command_${turn.id}`;
      const commandEvents = store.getTurnEvents(turn.id).filter((event) => {
        const data = event.data as { item?: { id: string }; itemId?: string };
        return (data.itemId ?? data.item?.id) === commandItemId;
      });
      const commandItem = store
        .listThreadItems('ws_demo', 'th_demo')
        .find((item) => item.id === commandItemId);

      expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
      expect(commandEvents[0]).toMatchObject({
        event: 'item.created',
        data: {
          type: 'item-created',
          item: {
            type: 'command-execution',
          },
        },
      });
      expect(commandEvents[1]).toMatchObject({
        event: 'item.delta',
        data: {
          type: 'item-delta',
          deltaKind: 'output-delta',
          itemType: 'command-execution',
          delta: 'simulator: ok',
        },
      });
      expect(commandEvents[2]).toMatchObject({
        event: 'item.completed',
        data: {
          type: 'item-completed',
        },
      });
      expect(commandItem?.output).toBe('simulator: ok');
    } finally {
      coreDb.sqlite.close();
    }
  });
});
