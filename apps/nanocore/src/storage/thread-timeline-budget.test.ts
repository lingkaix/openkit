// Storage integration fixtures exercise retained native authority through the public timeline read.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { prepareRetainedProductJson } from './immutable-content.js';
import { nativeProductScope, readNativeProduct } from './workspace-file-records.js';

it('keeps the 5000-run and 10000-Item timeline fixture within the server and payload budgets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timeline-budget-'));
  try {
    const store = await createDemoStore({ dataRoot: root });
    const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Budget fixture');
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
    expect(p95).toBeLessThanOrEqual(150);
  } finally {
    await disposeTestStore(root);
  }
}, 120_000);
