import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestGatewayConfig } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { readGoalView } from './goal-owner.js';

it('dispatches an ordinary Coordinator Turn through Gateway and invokes a table-derived Goal Tool', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'goal-gateway-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Gateway Goal');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: 'user_local' });
  const dispatch = vi
    .fn()
    .mockResolvedValueOnce({
      id: 'goal-call',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'card-create',
          name: 'goal_card_create',
          arguments: JSON.stringify({ description: 'Review the release', priority: 1 }),
        },
      ],
    })
    .mockResolvedValue({
      id: 'goal-idle',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Awaiting a human Plan decision.' }],
        },
      ],
    });
  const gatewayConfig = createTestGatewayConfig();
  gatewayConfig.logicalModels[0]!.contextManagement = [
    { type: 'compaction', compactThreshold: 64000 },
  ];
  const app = createApp({
    gatewayConfig,
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        kind: 'local',
        displayName: 'Test inference',
        defaultModel: 'openai/gpt-5.2',
        models: ['openai/gpt-5.2'],
      },
    ]),
    coreDb,
    dataRoot,
    store,
    llmGatewayDispatcher: { createResponses: dispatch } as never,
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(db);
  try {
    const response = await app.request('/api/app/operations/goal.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify({ workspaceId: workspace.id, intent: 'Review this release' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const created = await response.json();
    await vi.waitFor(
      () => {
        const turns = store.listThreadTurns(workspace.id, created.goal.threadId);
        expect(turns.length).toBeGreaterThan(0);
        expect(turns.map((turn) => ({ status: turn.status, error: turn.error }))).toEqual(
          expect.arrayContaining([{ status: 'completed', error: null }])
        );
        expect(
          turns.some((turn) => turn.status === 'failed'),
          JSON.stringify(turns.map((turn) => turn.error))
        ).toBe(false);
        expect(readGoalView(store, db, created.goal.goalId).cards).toMatchObject([
          { description: 'Review the release', revision: 0 },
        ]);
      },
      { timeout: 10000 }
    );
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(dispatch.mock.calls[0]?.[1].tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        'thread_items',
        'artifact_read',
        'turn_read',
        'evidence_runtime_list',
      ])
    );
    expect(store.listThreadAgentSessions(workspace.id, created.goal.threadId)).toEqual([]);
    expect(readGoalView(store, db, created.goal.goalId).tasks).toEqual([]);
    expect(readGoalView(store, db, created.goal.goalId).goal?.disposition).toBeNull();
    const calls = db.sqlite
      .prepare("SELECT operation,status FROM capability_calls WHERE operation='goal.coordinate'")
      .all();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => (call as { status: string }).status === 'succeeded')).toBe(true);
  } finally {
    db.sqlite.close();
    coreDb.sqlite.close();
  }
});
