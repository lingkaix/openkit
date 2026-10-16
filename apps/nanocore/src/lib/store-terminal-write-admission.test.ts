import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { finishCapabilityCall, startCapabilityCall } from '../capability/usage-ledger.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { openWorkspaceDb, verifyAndMigrateExistingScopedDatabases } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { reconcileWorkerMcpItems } from '../worker-mcp-routes.js';
import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  CONFIGURATION_APPLY_PENDING_DELAYED_USER_INPUT_ADMISSION,
  DISPLAY_PROJECTION_REFRESH_ADMISSION,
  type FsStore,
} from './store.js';

const LOCAL_ACTOR = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const COMPLETED_AT = '2026-09-22T00:00:00.000Z';

/**
 * Seeds one Demo Workspace turn and optionally seals it.
 *
 * @param store Store that owns the Demo Workspace.
 * @param status Requested lifecycle after seed.
 * @returns Seeded turn.
 */
function seedTurn(store: FsStore, status: 'running' | 'completed' | 'failed' = 'running') {
  const thread = store.createThread(
    'ws_00000000-0000-7000-8000-000000000001',
    'Terminal write admission'
  );
  const turn = store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    thread.id,
    'Admit terminal writes',
    LOCAL_ACTOR,
    null,
    {
      startedAt: COMPLETED_AT,
    }
  );
  if (status === 'running') {
    return turn;
  }
  return store.updateTurn(turn.id, {
    completedAt: COMPLETED_AT,
    ...(status === 'failed'
      ? { error: { code: 'test_failed', message: 'Turn failed.' }, status: 'failed' as const }
      : { status: 'completed' as const }),
  });
}

/**
 * Builds one completed status Item for a turn.
 *
 * @param turn Owning turn.
 * @param id Item id.
 * @param summary Display summary.
 * @param createdAt Created timestamp.
 * @returns Status item input.
 */
function statusItem(
  turn: ReturnType<FsStore['getTurnById']>,
  id: string,
  summary: string,
  createdAt = COMPLETED_AT
) {
  return {
    id,
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'status' as const,
    status: 'completed' as const,
    level: 'info' as const,
    title: 'Task Mode escalated to Goal Mode',
    summary,
    createdAt,
    completedAt: createdAt,
  };
}

/**
 * Seeds one succeeded MCP ledger row and a sealed-Turn tool-call Item for boot comparison.
 *
 * @param input Item identity, createdAt, and optional live-only parentItemId.
 * @returns Data root and store that own the seeded row.
 */
function seedMcpBootItem(input: {
  callId: string;
  capabilityId?: string;
  createdAt: string;
  itemId: string;
  parentItemId?: string;
  nullSnapshotLineage?: boolean;
  scopeItemId?: string;
  skipExistingItem?: boolean;
  skipSnapshot?: boolean;
}): { dataRoot: string; store: FsStore } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-mcp-'));
  const store = createDemoStore({ dataRoot });
  const turn = seedTurn(store, 'completed');
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(workspaceDb);
  const ledgerNow = new Date(COMPLETED_AT);
  try {
    const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
      suffix: 'mcp_boot',
      triggerActor: turn.triggerActor,
      workspaceInputIds: [],
      ...(input.scopeItemId ? { itemId: input.scopeItemId } : {}),
    });
    if (input.skipSnapshot) {
      rmSync(
        join(
          dirname(dirname(workspaceDb.sqlite.name)),
          'runtime',
          'agent-sessions',
          environmentPackage.scope.agentSessionId,
          'aep-snapshots'
        ),
        { force: true, recursive: true }
      );
    }
    const call = startCapabilityCall({
      agentId: 'agent_codex',
      agentSessionId: environmentPackage.scope.agentSessionId,
      authorityActor: turn.triggerActor,
      callId: input.callId,
      capabilityId: input.capabilityId ?? 'mcp.call_tool',
      family: 'mcp',
      itemId: input.itemId,
      now: ledgerNow,
      operation: 'mcp.call_tool',
      packageSnapshotId: environmentPackage.snapshotId,
      providerRef: 'echo',
      redactionClass: 'metadata-only',
      serviceRef: 'mcp-tool:echo',
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceDb,
      workspaceId: turn.workspaceId,
    });
    finishCapabilityCall({
      callId: call.id,
      now: ledgerNow,
      status: 'succeeded',
      workspaceDb,
    });
    if (input.nullSnapshotLineage) {
      workspaceDb.sqlite
        .prepare(
          'UPDATE capability_calls SET agent_session_id = NULL, package_snapshot_id = NULL WHERE call_id = ?'
        )
        .run(call.id);
    }
  } finally {
    workspaceDb.sqlite.close();
  }
  if (input.skipExistingItem) {
    return { dataRoot, store };
  }
  store.createItem(
    {
      arguments: null,
      causationId: input.callId,
      completedAt: COMPLETED_AT,
      createdAt: input.createdAt,
      durationMs: 0,
      error: null,
      id: input.itemId,
      ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
      result: null,
      server: 'echo',
      status: 'completed',
      threadId: turn.threadId,
      tool: 'echo',
      turnId: turn.id,
      type: 'tool-call',
      workspaceId: turn.workspaceId,
    },
    ALREADY_DECIDED_PUBLICATION_ADMISSION
  );
  return { dataRoot, store };
}

describe('post-terminal write admission', () => {
  it('rejects a plain new Item write against a terminal Turn', () => {
    const store = createDemoStore();
    const turn = seedTurn(store, 'completed');

    expect(() =>
      store.createItem(
        statusItem(turn, 'it_00000000-0000-7087-af6f-85feb4828a44', 'New after terminal')
      )
    ).toThrow(`Turn ${turn.id} is terminal and does not admit this write.`);
  });

  it('gates updateTurn, createItem, emitTurnEvent, and updateItem after terminal', () => {
    const store = createDemoStore();
    const turn = seedTurn(store, 'completed');
    const created = store.createItem(
      statusItem(turn, 'it_00000000-0000-72b3-a0f0-5a7ff4b63cfb', 'Display'),
      DISPLAY_PROJECTION_REFRESH_ADMISSION
    );

    expect(() => store.updateTurn(turn.id, { agentId: 'agent_codex_host' })).toThrow(
      `Turn ${turn.id} is terminal and does not admit this write.`
    );
    expect(() =>
      store.createItem(statusItem(turn, 'it_00000000-0000-73ad-8da6-f6643485b939', 'Another item'))
    ).toThrow(`Turn ${turn.id} is terminal and does not admit this write.`);
    expect(() =>
      store.emitTurnEvent(turn.id, {
        data: { type: 'error', code: 'plain', message: 'plain' },
        event: 'error',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
      })
    ).toThrow(`Turn ${turn.id} is terminal and does not admit this write.`);
    expect(() => store.updateItem(created.id, { title: 'Changed' })).toThrow(
      `Turn ${turn.id} is terminal and does not admit this write.`
    );
  });

  it('uses deep equality for already-decided publication and field-limited equality for display refresh', () => {
    const store = createDemoStore();
    const turn = seedTurn(store, 'completed');
    const decided = store.createItem(
      statusItem(turn, 'it_00000000-0000-788b-954a-51d98089bbd8', 'Decided summary'),
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    expect(
      store.createItem(
        statusItem(turn, 'it_00000000-0000-788b-954a-51d98089bbd8', 'Decided summary'),
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      )
    ).toEqual(decided);
    expect(() =>
      store.createItem(
        statusItem(
          turn,
          'it_00000000-0000-788b-954a-51d98089bbd8',
          'Decided summary',
          '2026-09-22T00:00:01.000Z'
        ),
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      )
    ).toThrow(
      `Turn ${turn.id} is terminal and the publication conflicts with the already-decided record.`
    );

    const display = store.createItem(
      statusItem(turn, 'it_00000000-0000-726f-a328-737bcd0a4586', 'Original summary'),
      DISPLAY_PROJECTION_REFRESH_ADMISSION
    );
    const refreshed = store.updateItem(
      display.id,
      { summary: 'Updated summary' },
      DISPLAY_PROJECTION_REFRESH_ADMISSION
    );
    expect(refreshed.summary).toBe('Updated summary');
    expect(refreshed.createdAt).toBe(display.createdAt);
    expect(refreshed.title).toBe(display.title);
    expect(
      store.updateItem(
        display.id,
        { level: 'info', title: display.title, summary: 'Updated summary' },
        DISPLAY_PROJECTION_REFRESH_ADMISSION
      )
    ).toEqual(refreshed);
    expect(() =>
      store.updateItem(
        display.id,
        { summary: 'Conflicting summary' },
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      )
    ).toThrow(
      `Turn ${turn.id} is terminal and the publication conflicts with the already-decided record.`
    );
  });

  it('admits identical, missing, and conflicting publications for terminalizeGovernedWorkerTurn', () => {
    const store = createDemoStore();
    const turn = seedTurn(store);
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: COMPLETED_AT,
      id: 'as_00000000-0000-7b5a-a83a-78d4ea18d1f1',
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: COMPLETED_AT,
      workspaceId: turn.workspaceId,
    });
    const input = {
      agentSessionId: 'as_00000000-0000-7b5a-a83a-78d4ea18d1f1',
      completedAt: COMPLETED_AT,
      errorCode: 'worker_governance_turn_failed',
      message: 'Worker failed.',
      outcome: 'failed' as const,
      requestId: null,
      store,
      turnId: turn.id,
    };

    expect(terminalizeGovernedWorkerTurn(input)).toMatchObject({ status: 'failed' });
    expect(terminalizeGovernedWorkerTurn(input)).toMatchObject({ status: 'failed' });
    expect(
      store
        .getTurnEvents(turn.id)
        .filter((event) => event.event === 'turn.completed' && event.data.type === 'turn-completed')
    ).toHaveLength(1);

    expect(
      terminalizeGovernedWorkerTurn({
        ...input,
        outcome: 'interrupted',
        errorCode: 'worker_governance_restart_recovery',
        message: 'Interrupted instead.',
      })
    ).toMatchObject({ status: 'failed', error: { code: 'worker_governance_turn_failed' } });
  });

  it('admits identical, missing, and conflicting MCP boot backfill publications', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-mcp-admission-'));
    const store = createDemoStore({ dataRoot });
    const turn = seedTurn(store, 'completed');
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);
    try {
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'mcp_admission',
        triggerActor: turn.triggerActor,
        workspaceInputIds: [],
      });
      const call = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: environmentPackage.scope.agentSessionId,
        authorityActor: turn.triggerActor,
        callId: 'cap_00000000-0000-7093-9d26-a0fb6e745bde',
        capabilityId: 'mcp.call_tool',
        family: 'mcp',
        itemId: 'it_00000000-0000-7716-8602-110ce91c304f',
        operation: 'mcp.call_tool',
        packageSnapshotId: environmentPackage.snapshotId,
        providerRef: 'echo',
        redactionClass: 'metadata-only',
        serviceRef: 'mcp-tool:echo',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceDb,
        workspaceId: turn.workspaceId,
      });
      finishCapabilityCall({ callId: call.id, status: 'succeeded', workspaceDb });
    } finally {
      workspaceDb.sqlite.close();
    }

    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(1);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(0);
    expect(store.listAllItems()).toContainEqual(
      expect.objectContaining({
        id: 'it_00000000-0000-7716-8602-110ce91c304f',
        causationId: 'cap_00000000-0000-7093-9d26-a0fb6e745bde',
      })
    );

    const conflictRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-mcp-admission-conflict-'));
    const conflictStore = createDemoStore({ dataRoot: conflictRoot });
    const conflictTurn = seedTurn(conflictStore, 'completed');
    const conflictDb = openWorkspaceDb(conflictRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(conflictDb);
    try {
      const call = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: 'as_00000000-0000-775f-b465-57ce886fa280',
        authorityActor: conflictTurn.triggerActor,
        callId: 'cap_00000000-0000-7e5e-b47c-e8154829070d',
        capabilityId: 'mcp.call_tool',
        family: 'mcp',
        itemId: 'it_00000000-0000-7585-88a1-d483d1404105',
        operation: 'mcp.call_tool',
        packageSnapshotId: 'aepsnap_conflict',
        providerRef: 'echo',
        redactionClass: 'metadata-only',
        serviceRef: 'mcp-tool:echo',
        threadId: conflictTurn.threadId,
        turnId: conflictTurn.id,
        workspaceDb: conflictDb,
        workspaceId: conflictTurn.workspaceId,
      });
      finishCapabilityCall({ callId: call.id, status: 'succeeded', workspaceDb: conflictDb });
    } finally {
      conflictDb.sqlite.close();
    }
    conflictStore.createItem(
      {
        arguments: null,
        causationId: 'cap_00000000-0000-7e5e-b47c-e8154829070d',
        completedAt: COMPLETED_AT,
        createdAt: COMPLETED_AT,
        durationMs: 0,
        error: null,
        id: 'it_00000000-0000-7585-88a1-d483d1404105',
        result: null,
        server: 'echo',
        status: 'failed',
        threadId: conflictTurn.threadId,
        tool: 'echo',
        turnId: conflictTurn.id,
        type: 'tool-call',
        workspaceId: conflictTurn.workspaceId,
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    verifyAndMigrateExistingScopedDatabases(conflictRoot);
    expect(() => reconcileWorkerMcpItems(conflictRoot, conflictStore)).toThrow(
      /conflicts with the already-decided record|MCP boot backfill conflicts/
    );
  });

  it('admits identical, missing, and conflicting approval-projection publications', () => {
    const store = createDemoStore();
    const turn = seedTurn(store, 'completed');
    const decision = {
      id: 'it_00000000-0000-76be-a8ee-b6bc95c15d80',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'approval-decision' as const,
      status: 'completed' as const,
      actor: LOCAL_ACTOR,
      causationId: 'req_approval_grid',
      approvalRequestId: 'apr_grid',
      decision: 'granted' as const,
      decidedAt: COMPLETED_AT,
      createdAt: COMPLETED_AT,
      completedAt: COMPLETED_AT,
    };
    expect(store.createItem(decision, ALREADY_DECIDED_PUBLICATION_ADMISSION)).toMatchObject({
      id: 'it_00000000-0000-76be-a8ee-b6bc95c15d80',
    });
    expect(store.createItem(decision, ALREADY_DECIDED_PUBLICATION_ADMISSION)).toMatchObject({
      id: 'it_00000000-0000-76be-a8ee-b6bc95c15d80',
    });
    expect(() =>
      store.createItem({ ...decision, decision: 'denied' }, ALREADY_DECIDED_PUBLICATION_ADMISSION)
    ).toThrow(
      `Turn ${turn.id} is terminal and the publication conflicts with the already-decided record.`
    );

    const completed = store.getTurnById(turn.id);
    store.emitTurnEvent(
      turn.id,
      {
        data: { type: 'turn-completed', stopReason: 'completed', turn: completed },
        event: 'turn.completed',
        requestId: 'req_approval_grid',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    const events = store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed');
    expect(events).toHaveLength(1);
    const replayed = store.emitTurnEvent(
      turn.id,
      {
        data: { type: 'turn-completed', stopReason: 'completed', turn: completed },
        event: 'turn.completed',
        requestId: 'req_approval_grid',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    expect(replayed.sequence).toBe(events[0]?.sequence);
    expect(() =>
      store.emitTurnEvent(
        turn.id,
        {
          data: { type: 'turn-completed', stopReason: 'aborted', turn: completed },
          event: 'turn.completed',
          requestId: 'req_approval_grid',
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        },
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      )
    ).toThrow(
      `Turn ${turn.id} is terminal and the publication conflicts with the already-decided record.`
    );
  });

  it('admits identical, missing, and conflicting Task-to-Goal explanation Items', () => {
    const store = createDemoStore();
    const turn = seedTurn(store, 'completed');
    const item = statusItem(
      turn,
      testEntityId('it', `it_task_goal_goal_1_${turn.id}`),
      'Escalate because the work is a Goal.'
    );
    expect(store.createItem(item, ALREADY_DECIDED_PUBLICATION_ADMISSION).summary).toBe(
      'Escalate because the work is a Goal.'
    );
    expect(store.createItem(item, ALREADY_DECIDED_PUBLICATION_ADMISSION).id).toBe(item.id);
    expect(() =>
      store.createItem(
        { ...item, summary: 'Different explanation' },
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      )
    ).toThrow(
      `Turn ${turn.id} is terminal and the publication conflicts with the already-decided record.`
    );
  });

  it('admits the configuration-apply marker Item pending delayed user input', () => {
    const store = createDemoStore();
    const turn = seedTurn(store, 'completed');
    const marker = store.createItem(
      {
        id: 'it_00000000-0000-7930-99d0-7ca81784886e',
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'status',
        status: 'completed',
        level: 'info',
        title: 'Configuration application started',
        summary: 'Request req_apply confirmed candidate digest.',
        createdAt: COMPLETED_AT,
        completedAt: COMPLETED_AT,
      },
      CONFIGURATION_APPLY_PENDING_DELAYED_USER_INPUT_ADMISSION
    );
    expect(marker.title).toBe('Configuration application started');
  });

  it('admits a turn.updated event that carries the sealed outcome and rejects one that disagrees', () => {
    const store = createDemoStore();
    const turn = seedTurn(store);
    const cancelled = store.updateTurn(turn.id, { status: 'cancelled' });
    const admitted = store.emitTurnEvent(turn.id, {
      data: { type: 'turn-updated', turn: cancelled },
      event: 'turn.updated',
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId: turn.workspaceId,
    });
    expect(admitted.event).toBe('turn.updated');
    expect(admitted.data).toEqual({ type: 'turn-updated', turn: cancelled });
    expect(() =>
      store.emitTurnEvent(turn.id, {
        data: { type: 'turn-updated', turn: { ...cancelled, status: 'completed' } },
        event: 'turn.updated',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
      })
    ).toThrow(
      `Turn ${turn.id} is terminal and the publication conflicts with the already-decided record.`
    );
  });

  it('rejects an unrelated error event that only carries a matching nested Turn', () => {
    const store = createDemoStore();
    const turn = seedTurn(store);
    const cancelled = store.updateTurn(turn.id, { status: 'cancelled' });

    expect(() =>
      store.emitTurnEvent(turn.id, {
        data: {
          type: 'error',
          code: 'injected',
          message: 'not the decided outcome',
          turn: cancelled,
        },
        event: 'error',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
      })
    ).toThrow(`Turn ${turn.id} is terminal and does not admit this write.`);
  });

  it('rejects MCP boot when createdAt disagrees with the reconstructed publication', () => {
    const { dataRoot, store } = seedMcpBootItem({
      callId: 'cap_00000000-0000-76ba-b8df-bac9d2a0c398',
      createdAt: '1999-01-01T00:00:00.000Z',
      itemId: 'it_00000000-0000-748c-8305-6a5f709ad4dc',
    });
    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(() => reconcileWorkerMcpItems(dataRoot, store)).toThrow(
      /MCP boot backfill conflicts with already-decided Item: it_mcp_createdat/
    );
  });

  it('rejects MCP boot when parentItemId disagrees with the snapshot-decided publication', () => {
    const { dataRoot, store } = seedMcpBootItem({
      callId: 'cap_00000000-0000-7857-bc0e-eeefad7b0be3',
      createdAt: COMPLETED_AT,
      itemId: 'it_00000000-0000-769e-be1f-7403aafc125a',
      parentItemId: 'it_00000000-0000-7cf3-9109-8d6d8c869be2',
      scopeItemId: 'it_00000000-0000-7d4f-8cf2-74191ea3ce50',
    });
    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(() => reconcileWorkerMcpItems(dataRoot, store)).toThrow(
      /MCP boot backfill conflicts with already-decided Item: it_mcp_parent/
    );
  });

  it('fills a missing MCP Item with the parentItemId its AEP snapshot decided', () => {
    const { dataRoot, store } = seedMcpBootItem({
      callId: 'cap_00000000-0000-7cdc-b914-b7a5d15e233e',
      createdAt: COMPLETED_AT,
      itemId: 'it_00000000-0000-771b-ae29-9f651adf70c6',
      scopeItemId: 'it_00000000-0000-7d4f-8cf2-74191ea3ce50',
      skipExistingItem: true,
    });
    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(1);
    expect(
      store.listAllItems().find((item) => item.id === 'it_00000000-0000-771b-ae29-9f651adf70c6')
    ).toMatchObject({
      parentItemId: 'it_00000000-0000-7d4f-8cf2-74191ea3ce50',
    });
  });

  it('publishes nothing for a row whose named AEP snapshot cannot be read', () => {
    // The decided publication cannot be rebuilt without its snapshot, and an Item without the parent
    // it carried is a different record. Leaving the row lets a later boot fill it truthfully.
    const missing = seedMcpBootItem({
      callId: 'cap_00000000-0000-7053-bc05-8a6277272c95',
      createdAt: COMPLETED_AT,
      itemId: 'it_00000000-0000-7cc3-9117-739fef9522e4',
      skipExistingItem: true,
      skipSnapshot: true,
    });
    verifyAndMigrateExistingScopedDatabases(missing.dataRoot);
    expect(reconcileWorkerMcpItems(missing.dataRoot, missing.store)).toBe(0);
    expect(
      missing.store
        .listAllItems()
        .find((item) => item.id === 'it_00000000-0000-7cc3-9117-739fef9522e4')
    ).toBeUndefined();

    const present = seedMcpBootItem({
      callId: 'cap_00000000-0000-71c8-aeb1-254bd7d88893',
      createdAt: COMPLETED_AT,
      itemId: 'it_00000000-0000-7b9c-ab46-70e2fb10d1b6',
      parentItemId: 'it_00000000-0000-7cf3-9109-8d6d8c869be2',
      skipSnapshot: true,
    });
    verifyAndMigrateExistingScopedDatabases(present.dataRoot);
    expect(reconcileWorkerMcpItems(present.dataRoot, present.store)).toBe(0);
  });

  it('rejects a stored Item with no parent against a snapshot-decided parent', () => {
    // Nothing writes this pair any more: a row whose snapshot is unreadable is left unfilled rather
    // than published without its parent, so a stored null against a decided parent is a conflict.
    const { dataRoot, store } = seedMcpBootItem({
      callId: 'cap_00000000-0000-73aa-add4-e2d3c68bbad4',
      createdAt: COMPLETED_AT,
      itemId: 'it_00000000-0000-78cf-ac54-13510d8883d9',
      scopeItemId: 'it_00000000-0000-7d4f-8cf2-74191ea3ce50',
    });
    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(() => reconcileWorkerMcpItems(dataRoot, store)).toThrow(
      /MCP boot backfill conflicts with already-decided Item: it_mcp_parent_backfilled/
    );
  });

  it('still fills a row whose stored snapshot lineage is absent, without inventing a parent', () => {
    const { dataRoot, store } = seedMcpBootItem({
      callId: 'cap_00000000-0000-7ba9-b455-c6bed7426d40',
      createdAt: COMPLETED_AT,
      itemId: 'it_00000000-0000-7e65-81be-6ad9d7083cfc',
      nullSnapshotLineage: true,
      skipExistingItem: true,
    });
    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(1);
    const filled = store
      .listAllItems()
      .find((item) => item.id === 'it_00000000-0000-7e65-81be-6ad9d7083cfc');
    expect(filled).toMatchObject({
      causationId: 'cap_00000000-0000-7ba9-b455-c6bed7426d40',
      status: 'completed',
    });
    expect(filled as unknown as { parentItemId?: string }).not.toHaveProperty('parentItemId');
  });

  it('leaves a generative MCP call row alone because it published no tool-call Item', () => {
    // Generative rows carry capability_id 'mcp.call_tool.<name>' and store the parent Item in item_id.
    const { dataRoot, store } = seedMcpBootItem({
      callId: 'cap_00000000-0000-7bae-80ab-e61aec7becb8',
      capabilityId: 'mcp.call_tool.openkit_generative_present',
      createdAt: COMPLETED_AT,
      itemId: 'it_00000000-0000-7ab4-86dd-d5511a0d438e',
      skipExistingItem: true,
    });
    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(0);
    expect(
      store.listAllItems().find((item) => item.id === 'it_00000000-0000-7ab4-86dd-d5511a0d438e')
    ).toBe(undefined);
  });

  it('rejects a brand-new turn-output Artifact against a sealed Turn', () => {
    const store = createDemoStore();
    const turn = seedTurn(store, 'completed');
    const body = 'new after terminal';
    const digest = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;

    expect(() =>
      store.createArtifact({
        id: 'ar_00000000-0000-78c4-95cd-6093ab5a4c37',
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        kind: 'summary',
        title: 'After terminal',
        status: 'ready',
        summary: 'Brand-new after seal.',
        version: 1,
        content: { format: 'markdown', body },
        contentDigest: digest,
        lastMutationRequestId: 'req_after_terminal',
        origin: {
          kind: 'turn-output',
          requestId: 'req_after_terminal',
          threadId: turn.threadId,
          turnId: turn.id,
        },
        createdAt: COMPLETED_AT,
        updatedAt: COMPLETED_AT,
      })
    ).toThrow(`Turn ${turn.id} is terminal and does not admit this write.`);
  });
});
