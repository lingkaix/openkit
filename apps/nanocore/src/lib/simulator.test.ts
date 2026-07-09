import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import {
  ensureLocalhostSchedulerBaseline,
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
  ensureLocalhostSchedulerBaseline(coreDb);
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

  it('runs the same paused approval and question lifecycle across three turns', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const app = createApp({ coreDb, store, turnExecutor: executor });

    try {
      await linkRepository(app);

      for (const index of [1, 2, 3]) {
        const turnResponse = await app.request('/api/turns', {
          method: 'POST',
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            requestId: `0190f4c8-0000-7000-8000-00000000021${index}`,
            input: `Simulated run ${index}`,
          }),
          headers: { 'content-type': 'application/json' },
        });
        const turn = (await turnResponse.json()) as { id: string };

        expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
        expect(store.getTurnById(turn.id)).toMatchObject({
          status: 'awaiting_human',
          humanGate: {
            kind: 'approval',
            approvalRequestId: `ap_${turn.id}`,
            itemId: `it_approval_request_${turn.id}`,
          },
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
        expect(
          store
            .getTurnEvents(turn.id)
            .filter((event) => event.event === 'item.delta')
            .map((event) => (event.data as { deltaKind?: string }).deltaKind)
        ).toEqual(['text-delta', 'text-delta', 'indexed-text-delta', 'output-delta']);
        const startRequestIds = [
          ...new Set(store.getTurnEvents(turn.id).map((event) => event.requestId)),
        ];

        expect(startRequestIds).toHaveLength(1);
        expect(startRequestIds[0]).toBe(`0190f4c8-0000-7000-8000-00000000021${index}`);

        const approvalResponse = await app.request(`/api/approvals/ap_${turn.id}/respond`, {
          method: 'POST',
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: turn.id,
            requestId: `0190f4c8-0000-7000-8000-00000000022${index}`,
            decision: 'granted',
          }),
          headers: { 'content-type': 'application/json' },
        });

        expect(approvalResponse.status).toBe(200);
        expect(store.getTurnById(turn.id)).toMatchObject({
          status: 'awaiting_human',
          humanGate: {
            kind: 'user-input',
            userInputRequestId: `ui_${turn.id}`,
            itemId: `it_user_input_request_${turn.id}`,
          },
        });
        expect(
          store
            .getTurnEvents(turn.id)
            .filter((event) => {
              return (
                event.data.type === 'item-created' && event.data.item.type === 'approval-decision'
              );
            })
            .map((event) => event.requestId)
        ).toEqual([`0190f4c8-0000-7000-8000-00000000022${index}`]);
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
          'approval-decision',
          'user-input-request',
        ]);

        const answerResponse = await app.request('/api/turns', {
          method: 'POST',
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: turn.id,
            requestId: `0190f4c8-0000-7000-8000-00000000023${index}`,
            input: 'Use the deterministic simulator path.',
          }),
          headers: { 'content-type': 'application/json' },
        });

        expect(answerResponse.status).toBe(202);
        expect(store.getTurnById(turn.id).status).toBe('completed');
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
          'approval-decision',
          'user-input-request',
          'user-input-response',
          'artifact-reference',
        ]);
        expect(store.getTurnEvents(turn.id).map((event) => event.event)).toEqual(
          expect.arrayContaining(['artifact.updated', 'turn.completed'])
        );
        expect(
          store
            .getTurnEvents(turn.id)
            .filter(
              (event) => event.event === 'artifact.updated' || event.event === 'turn.completed'
            )
            .map((event) => event.requestId)
        ).toEqual([
          `0190f4c8-0000-7000-8000-00000000023${index}`,
          `0190f4c8-0000-7000-8000-00000000023${index}`,
        ]);
        expect(
          store.getTurnEvents(turn.id).find((event) => {
            return event.data.type === 'item-delta' && event.data.deltaKind === 'artifact-updated';
          })?.data
        ).toMatchObject({
          type: 'item-delta',
          itemType: 'artifact-reference',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
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
