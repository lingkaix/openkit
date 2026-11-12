// Storage integration fixtures exercise retained native authority through the public timeline read.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { testBudgetLimit } from './budget-test-limit.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { prepareRetainedProductJson } from './immutable-content.js';
import { nativeProductScope, readNativeProduct } from './workspace-file-records.js';

it('keeps timeline and dashboard windows bounded as native history and unrelated Threads grow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timeline-budget-'));
  try {
    const store = await createDemoStore({ dataRoot: root });
    const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Budget fixture');
    const siblings = [];
    for (let index = 0; index < 20; index++)
      siblings.push(await store.createThread(DEMO_WORKSPACE_ID, `Sibling ${index}`));
    const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
    const seed = await store.createTurn(
      DEMO_WORKSPACE_ID,
      thread.id,
      'Native retained header',
      actor
    );
    await store.completeTurn(seed.id, {
      status: 'completed',
      completedAt: '2026-11-08T17:00:00.000Z',
    });
    const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
    const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID });
    const retained = readNativeProduct(scope, 'turn', seed.id)!;
    await shutdownControlStoreWorkerClient();
    // Real read-boundary fixture from an owner-created terminal header. This does
    // not qualify execution, terminal receipts, sealing or whole-Store bootstrap.
    const sqlite = new Database(scope.path, { fileMustExist: true });
    try {
      const insert = sqlite.prepare(
        'INSERT INTO control_turns(id,thread_id,agent_session_id,status,schema_version,revision,record_json) VALUES(?,?,NULL,?,1,1,?)'
      );
      sqlite.transaction(() => {
        for (let index = 1; index < 4_999; index++) {
          const id = allocateEntityId('tu');
          const record = { ...retained.record, id };
          insert.run(id, thread.id, record.status, JSON.stringify(record));
        }
      })();
    } finally {
      sqlite.close();
    }
    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      thread.id,
      'Ten thousand ordinary messages',
      actor
    );
    const client = getControlStoreWorkerClient();
    const database = `workspace:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    // Use the real native entry writer in its bounded 32-entry tuples, with each FULL ACK.
    for (let start = 0; start < 10_000; start += 32) {
      const entries = [];
      for (let index = start; index < Math.min(10_000, start + 32); index++) {
        const item = {
          id: allocateEntityId('it'),
          owner: scope.owner,
          threadId: thread.id,
          turnId: turn.id,
          type: 'assistant-message',
          status: 'completed',
          text: `Progress note ${index}`,
          createdAt: '2026-11-08T17:00:00.000Z',
          completedAt: '2026-11-08T17:00:00.000Z',
        };
        entries.push({
          kind: 'item' as const,
          turnId: turn.id,
          sequence: index + 1,
          expectedRevision: 0,
          ...(await prepareRetainedProductJson(
            scope.contentMount,
            scope.owner,
            join(root, 'workspaces', DEMO_WORKSPACE_ID, 'runtime', 'staging'),
            writeRetainedV1(item)
          )),
        });
      }
      await client.products(database, { products: [], entries });
    }
    const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
    const samples: number[] = [];
    for (let index = 0; index < 25; index++) {
      const start = performance.now();
      const response = await app.request('/api/app/operations/thread.timeline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selector),
      });
      const text = await response.text();
      const elapsed = performance.now() - start;
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(262_144);
      const result = JSON.parse(text);
      expect(result.runs).toHaveLength(31);
      expect(result.runs.at(-1).id).toBe(turn.id);
      expect(result.runs.at(-1).statistics.messages).toBe(10_000);
      if (index >= 5) samples.push(elapsed);
    }
    const ordered = [...samples].sort((left, right) => left - right);
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1]!;
    console.info(
      'TB2 window budget',
      JSON.stringify({ runs: 5_000, latestRunItems: 10_000, samples, p95 })
    );
    expect(p95).toBeLessThanOrEqual(testBudgetLimit(p95, 150));
    const forbidden = [
      'listThreadTurns',
      'listThreadItems',
      'listThreads',
      'listArtifacts',
      'listCommandRequests',
    ] as const;
    const spies = forbidden.map((name) =>
      vi.spyOn(store, name).mockImplementation(() => {
        throw new Error(`Dashboard called ${name}`);
      })
    );
    const dashboardSamples = async () => {
      const samples: number[] = [];
      let bytes = 0;
      for (let sample = 0; sample < 25; sample++) {
        const start = performance.now();
        const response = await app.request('/api/app/operations/thread.dashboard', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(selector),
        });
        const text = await response.text();
        const elapsed = performance.now() - start;
        expect(response.status).toBe(200);
        bytes = Buffer.byteLength(text);
        expect(bytes).toBeLessThanOrEqual(32768);
        const dashboard = JSON.parse(text);
        expect(dashboard.turns).toHaveLength(1);
        expect(dashboard.turns[0]).toMatchObject({ id: turn.id, items: [] });
        expect(dashboard.now).toMatchObject({ turnId: turn.id, status: 'running' });
        if (sample >= 5) samples.push(elapsed);
      }
      samples.sort((a, b) => a - b);
      return { samples, p95: samples[Math.ceil(samples.length * 0.95) - 1]!, bytes };
    };
    try {
      const before = await dashboardSamples();
      await shutdownControlStoreWorkerClient();
      const growthDb = new Database(scope.path, { fileMustExist: true });
      try {
        const insert = growthDb.prepare(
          'INSERT INTO control_turns(id,thread_id,agent_session_id,status,schema_version,revision,record_json) VALUES(?,?,NULL,?,1,1,?)'
        );
        growthDb.transaction(() => {
          // A metadata-only read-boundary fixture, never qualification of Turn execution or terminal receipts.
          for (let index = 0; index < 15000; index++) {
            const id = allocateEntityId('tu');
            const threadId = index < 5000 ? thread.id : siblings[index % siblings.length]!.id;
            insert.run(
              id,
              threadId,
              retained.record.status,
              JSON.stringify({ ...retained.record, id, threadId })
            );
          }
        })();
      } finally {
        growthDb.close();
      }
      const after = await dashboardSamples();
      console.info(
        'TB4 dashboard growth',
        JSON.stringify({
          beforeRuns: 5000,
          afterSelectedRuns: 10000,
          unrelatedThreads: 20,
          unrelatedRuns: 10000,
          currentRunItems: 10000,
          before,
          after,
        })
      );
      expect(after.bytes).toBe(before.bytes);
      expect(after.p95).toBeLessThanOrEqual(150);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  } finally {
    await disposeTestStore(root);
  }
}, 120_000);
