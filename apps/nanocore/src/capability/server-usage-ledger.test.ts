import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityCallSchema, ServerUsageRecordSchema } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import {
  digestLlmSystemPrompt,
  persistLlmCapabilityCallSystemPromptDigest,
} from '../llm/system-prompt-digest.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { closeTestCoreDb } from '../test-support/store.js';
import {
  finishCapabilityCall,
  listServerCapabilityCalls,
  listServerUsageRecords,
  recordUsage,
  recoverRunningCapabilityCalls,
  type StartServerCapabilityCallInput,
  stampCapabilityCallSchemaSnapshot,
  startCapabilityCall,
  writeGatewayRouteLineage,
} from './usage-ledger.js';

/** Opens the real existing Core owner; query-only Main makes any live SQL fallback fail. */
async function openNativeServerLedger(coreDb: CoreDb): Promise<void> {
  const scope = nativeProductScope(coreDb.dataRoot, { kind: 'server' });
  coreDb.sqlite.pragma('query_only = ON');
  await getControlStoreWorkerClient().open({
    database: `core:${scope.path}`,
    path: scope.path,
    dataRoot: coreDb.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
}

/** Supplies trusted Server inputs without manufacturing a retained Call or Audit. */
function serverInput(coreDb: CoreDb): StartServerCapabilityCallInput {
  return {
    workspaceDb: coreDb,
    owner: { kind: 'server' },
    authorityActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    capabilityId: 'llm.responses',
    family: 'llm',
    operation: 'responses.create',
    providerRef: 'provider_test',
    redactionClass: 'metadata-only',
    requestId: '00000000-0000-4000-8000-000000000001',
    now: new Date('2026-10-18T00:00:00.000Z'),
  };
}

it('retains Server calls and measured usage in Core without a Workspace and recovers without replay', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-usage-'));
  let coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    await openNativeServerLedger(coreDb);
    const input = {
      workspaceDb: coreDb,
      owner: { kind: 'server' as const },
      authorityActor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      capabilityId: 'llm.responses',
      family: 'llm' as const,
      operation: 'responses.create',
      providerRef: 'provider_test',
      redactionClass: 'metadata-only',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
      requestId: '00000000-0000-4000-8000-000000000001',
      now: new Date('2026-10-18T00:00:00.000Z'),
    };
    // Core Storage, SQLite Layers: Main cannot own the moved live writer or split its linked tuple.
    const call = await startCapabilityCall(input);
    expect(
      coreDb.sqlite
        .prepare(
          "SELECT actor_json FROM audit_events WHERE capability_call_id = ? AND action = 'capability.admit'"
        )
        .get(call.id)
    ).toEqual({ actor_json: JSON.stringify(input.authorityActor) });
    expect(await startCapabilityCall(input)).toMatchObject({ id: call.id, inserted: false });
    await expect(
      Promise.resolve().then(() =>
        startCapabilityCall({ ...input, turnId: 'tu_00000000-0000-7000-8000-000000000002' })
      )
    ).rejects.toThrow('attribution conflicts');
    const systemPromptDigest = digestLlmSystemPrompt({
      endpoint: 'responses',
      request: { instructions: 'Server maintenance prompt', input: 'Inspect status' },
    });
    await persistLlmCapabilityCallSystemPromptDigest({
      workspaceDb: coreDb,
      callId: call.id,
      systemPromptDigest,
    });
    await writeGatewayRouteLineage({
      workspaceDb: coreDb,
      call,
      logicalModelId: 'maintenance',
      entry: {
        kind: 'attempt',
        routeMemberId: 'member',
        providerProfileId: 'provider_test',
        providerModel: 'test-model',
        selectionReason: 'configured',
        attemptOrder: 0,
        retryIndex: 0,
        outputBegan: true,
        terminalResult: 'succeeded',
      },
    });
    const records = [
      {
        category: 'llm' as const,
        unit: 'tokens' as const,
        quantity: 7,
        modelId: 'maintenance',
        source: 'input',
      },
    ];
    const usageIds = await recordUsage({ workspaceDb: coreDb, call, records, now: input.now });
    expect(await recordUsage({ workspaceDb: coreDb, call, records, now: input.now })).toEqual(
      usageIds
    );
    await finishCapabilityCall({
      workspaceDb: coreDb,
      callId: call.id,
      status: 'succeeded',
      now: input.now,
    });
    const [retained] = listServerCapabilityCalls(coreDb);
    expect(retained).toHaveProperty('systemPromptDigest', systemPromptDigest);
    expect(retained?.extensions).toMatchObject({
      'openkit.gateway/routeLineage': {
        logicalModelId: 'maintenance',
        entries: [
          {
            kind: 'attempt',
            routeMemberId: 'member',
            providerProfileId: 'provider_test',
            providerModel: 'test-model',
            selectionReason: 'configured',
            attemptOrder: 0,
            retryIndex: 0,
            outputBegan: true,
            terminalResult: 'succeeded',
          },
        ],
      },
    });
    const [usage] = listServerUsageRecords(coreDb);
    expect(CapabilityCallSchema.parse(retained)).toMatchObject({
      owner: { kind: 'server' },
      status: 'succeeded',
    });
    expect(retained).not.toHaveProperty('workspaceId');
    expect(ServerUsageRecordSchema.parse(usage)).toMatchObject({
      owner: { kind: 'server' },
      quantity: 7,
      capabilityCallId: call.id,
      responsibleUserId: input.authorityActor.id,
    });
    expect(usage).not.toHaveProperty('workspaceId');
    coreDb.sqlite.pragma('query_only = OFF');
    try {
      for (const table of ['capability_calls', 'usage_records'])
        expect(() =>
          coreDb.sqlite
            .prepare(`UPDATE ${table} SET workspace_id = ?`)
            .run('ws_00000000-0000-7000-8000-000000000001')
        ).toThrow('CHECK constraint failed');
    } finally {
      coreDb.sqlite.pragma('query_only = ON');
    }
    expect(
      ServerUsageRecordSchema.safeParse({
        ...usage,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }).success
    ).toBe(false);
    expect(coreDb.sqlite.prepare('SELECT workspace_id FROM capability_calls').get()).toEqual({
      workspace_id: null,
    });
    expect(
      coreDb.sqlite.prepare('SELECT workspace_id, capability_call_id FROM audit_events').get()
    ).toMatchObject({ workspace_id: null, capability_call_id: call.id });
    const auditBeforeRestart = listServerAuditEvents(coreDb).filter(
      (event) => event.capabilityCallId === call.id
    );
    expect(auditBeforeRestart).toHaveLength(2);
    expect(auditBeforeRestart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'capability.admit',
          actor: input.authorityActor,
          requestId: input.requestId,
          outcome: 'unknown',
        }),
        expect.objectContaining({
          action: 'capability.finish',
          actor: input.authorityActor,
          requestId: input.requestId,
          outcome: 'succeeded',
        }),
      ])
    );
    const retainedBeforeRestart = listServerCapabilityCalls(coreDb);
    const usageBeforeRestart = listServerUsageRecords(coreDb);
    const pending = await startCapabilityCall({
      ...input,
      requestId: null,
      auditLineage: { commandRequestId: input.requestId },
    });
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    await openNativeServerLedger(coreDb);
    expect(await recoverRunningCapabilityCalls({ workspaceDb: coreDb, now: input.now })).toBe(1);
    expect(listServerCapabilityCalls(coreDb).filter((row) => row.id === call.id)).toEqual(
      retainedBeforeRestart
    );
    expect(listServerUsageRecords(coreDb)).toEqual(usageBeforeRestart);
    expect(
      listServerAuditEvents(coreDb).filter((event) => event.capabilityCallId === call.id)
    ).toEqual(auditBeforeRestart);
    expect(await startCapabilityCall({ ...input, workspaceDb: coreDb })).toMatchObject({
      id: call.id,
      inserted: false,
    });
    expect(await recordUsage({ workspaceDb: coreDb, call, records, now: input.now })).toEqual(
      usageIds
    );
    expect(
      listServerAuditEvents(coreDb).filter((event) => event.capabilityCallId === call.id)
    ).toEqual(auditBeforeRestart);
    expect(
      listServerCapabilityCalls(coreDb).find((entry) => entry.id === pending.id)
    ).toMatchObject({ status: 'unknown', errorCode: 'capability_call_recovered_after_restart' });
    expect(listServerUsageRecords(coreDb)).toHaveLength(1);
    expect(
      coreDb.sqlite
        .prepare(
          "SELECT actor_json, request_id FROM audit_events WHERE capability_call_id = ? AND action = 'capability.finish'"
        )
        .get(pending.id)
    ).toEqual({ actor_json: JSON.stringify(input.authorityActor), request_id: input.requestId });
  } finally {
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it.each([
  'llm',
  'mcp',
] as const)('keeps unattributed Server %s diagnostics separate from Workspace admission', async (family) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-null-admission-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    await openNativeServerLedger(coreDb);
    const call = await startCapabilityCall({
      workspaceDb: coreDb,
      owner: { kind: 'server' },
      authorityActor: null,
      capabilityId: `${family}.server_diagnostic`,
      family,
      operation: 'diagnostic.observe',
      redactionClass: 'metadata-only',
    });
    expect(call.context.authorityActor).toBeNull();
    expect(listServerCapabilityCalls(coreDb)).toEqual([
      expect.objectContaining({ id: call.id, owner: { kind: 'server' }, family }),
    ]);
    expect(coreDb.sqlite.prepare('SELECT workspace_id FROM capability_calls').get()).toEqual({
      workspace_id: null,
    });
    expect(coreDb.sqlite.prepare('SELECT * FROM audit_events').all()).toEqual([]);
  } finally {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('rolls back Server admission when its actual linked Audit fails and returns no success acknowledgement', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-admit-audit-fault-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    await openNativeServerLedger(coreDb);
    // Fault injection follows real schema and native-owner setup. It creates no product records.
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec(`CREATE TRIGGER refuse_server_admission_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'capability.admit'
      BEGIN SELECT RAISE(ABORT, 'injected Server admission Audit failure'); END`);
    coreDb.sqlite.pragma('query_only = ON');
    await expect(
      Promise.resolve().then(() => startCapabilityCall(serverInput(coreDb)))
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect(listServerCapabilityCalls(coreDb)).toEqual([]);
    expect(listServerUsageRecords(coreDb)).toEqual([]);
    expect(listServerAuditEvents(coreDb)).toEqual([]);
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec('DROP TRIGGER refuse_server_admission_audit');
    coreDb.sqlite.pragma('query_only = ON');
    const call = await startCapabilityCall(serverInput(coreDb));
    expect(call.inserted).toBe(true);
    expect(listServerAuditEvents(coreDb)).toEqual([
      expect.objectContaining({ action: 'capability.admit', capabilityCallId: call.id }),
    ]);
  } finally {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('keeps the earlier Server usage commit when terminal Audit fails and never acknowledges a partial finish', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-finish-audit-fault-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    await openNativeServerLedger(coreDb);
    const call = await startCapabilityCall(serverInput(coreDb));
    const records = [
      { category: 'llm' as const, unit: 'tokens' as const, quantity: 7, source: 'input' },
    ];
    const ids = await recordUsage({ workspaceDb: coreDb, call, records });
    const usage = listServerUsageRecords(coreDb);
    const audit = listServerAuditEvents(coreDb);
    // Usage and finish are separate original commits; a failed finish cannot roll back acknowledged usage.
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec(`CREATE TRIGGER refuse_server_finish_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'capability.finish'
      BEGIN SELECT RAISE(ABORT, 'injected Server finish Audit failure'); END`);
    coreDb.sqlite.pragma('query_only = ON');
    await expect(
      Promise.resolve().then(() =>
        finishCapabilityCall({
          workspaceDb: coreDb,
          callId: call.id,
          status: 'succeeded',
        })
      )
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect(listServerCapabilityCalls(coreDb)).toEqual([
      expect.objectContaining({ id: call.id, status: 'running', completedAt: null }),
    ]);
    expect(listServerUsageRecords(coreDb)).toEqual(usage);
    expect(listServerAuditEvents(coreDb)).toEqual(audit);
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec('DROP TRIGGER refuse_server_finish_audit');
    coreDb.sqlite.pragma('query_only = ON');
    await finishCapabilityCall({ workspaceDb: coreDb, callId: call.id, status: 'succeeded' });
    await shutdownControlStoreWorkerClient();
    const reopened = openCoreDb(dataRoot);
    try {
      expect(listServerCapabilityCalls(reopened)).toEqual([
        expect.objectContaining({ id: call.id, status: 'succeeded' }),
      ]);
      expect(listServerUsageRecords(reopened)).toEqual(usage);
      expect(listServerUsageRecords(reopened).map((row) => row.id)).toEqual(ids);
      expect(
        listServerAuditEvents(reopened).filter((row) => row.action === 'capability.finish')
      ).toEqual([
        expect.objectContaining({
          capabilityCallId: call.id,
          actor: serverInput(coreDb).authorityActor,
          outcome: 'succeeded',
        }),
      ]);
    } finally {
      closeTestCoreDb(reopened);
    }
  } finally {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('refuses Workspace addressing in Core before admission or usage and retains Server schema attribution', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-owner-boundary-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    await openNativeServerLedger(coreDb);
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const malformed = {
      ...serverInput(coreDb),
      workspaceId,
    } as unknown as StartServerCapabilityCallInput;
    await expect(Promise.resolve().then(() => startCapabilityCall(malformed))).rejects.toThrow();
    expect(listServerCapabilityCalls(coreDb)).toEqual([]);
    expect(listServerAuditEvents(coreDb)).toEqual([]);
    const call = await startCapabilityCall(serverInput(coreDb));
    const schemaSnapshotId = 'sha256:' + 'a'.repeat(64);
    await stampCapabilityCallSchemaSnapshot({
      workspaceDb: coreDb,
      callId: call.id,
      schemaSnapshotId,
    });
    await stampCapabilityCallSchemaSnapshot({
      workspaceDb: coreDb,
      callId: call.id,
      schemaSnapshotId,
    });
    expect(listServerCapabilityCalls(coreDb)).toEqual([
      expect.objectContaining({ id: call.id, schemaSnapshotId, owner: { kind: 'server' } }),
    ]);
    await expect(
      Promise.resolve().then(() =>
        stampCapabilityCallSchemaSnapshot({
          workspaceDb: coreDb,
          callId: call.id,
          schemaSnapshotId: 'sha256:' + 'b'.repeat(64),
        })
      )
    ).rejects.toThrow();
    const malformedCall = { ...call, context: { ...call.context, workspaceId } };
    await expect(
      Promise.resolve().then(() =>
        recordUsage({
          workspaceDb: coreDb,
          call: malformedCall,
          records: [{ category: 'llm', unit: 'tokens', quantity: 7 }],
        })
      )
    ).rejects.toThrow();
    expect(listServerUsageRecords(coreDb)).toEqual([]);
    expect(listServerCapabilityCalls(coreDb)).toHaveLength(1);
    expect(listServerAuditEvents(coreDb)).toHaveLength(1);
  } finally {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('fails the Server call with its linked Audit when usage storage refuses its measurement and returns no usage acknowledgement', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-usage-fault-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    await openNativeServerLedger(coreDb);
    const input = serverInput(coreDb);
    const call = await startCapabilityCall(input);
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec(`CREATE TRIGGER refuse_server_usage BEFORE INSERT ON usage_records
      BEGIN SELECT RAISE(ABORT, 'injected Server usage failure'); END`);
    coreDb.sqlite.pragma('query_only = ON');
    await expect(
      Promise.resolve().then(() =>
        recordUsage({
          workspaceDb: coreDb,
          call,
          records: [{ category: 'llm', unit: 'tokens', quantity: 7 }],
        })
      )
    ).rejects.toThrow();
    expect(listServerUsageRecords(coreDb)).toEqual([]);
    expect(listServerCapabilityCalls(coreDb)).toEqual([
      expect.objectContaining({ id: call.id, status: 'failed', errorCode: 'usage_record_failed' }),
    ]);
    expect(
      listServerAuditEvents(coreDb).filter((row) => row.action === 'capability.finish')
    ).toEqual([
      expect.objectContaining({
        capabilityCallId: call.id,
        actor: input.authorityActor,
        requestId: input.requestId,
        outcome: 'failed',
        errorCode: 'usage_record_failed',
      }),
    ]);
  } finally {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('keeps Server prompt-digest eligibility and missing-row refusal on the native owner', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-prompt-digest-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    await openNativeServerLedger(coreDb);
    const systemPromptDigest = digestLlmSystemPrompt({
      endpoint: 'responses',
      request: { instructions: 'Server prompt' },
    });
    // Work Data Retention Format limits this existing slot to the two Gateway-entry capabilities.
    for (const [family, capabilityId, eligible] of [
      ['llm', 'llm.chat_completions', true],
      ['llm', 'llm.responses', true],
      ['llm', 'inference.local.goal_coordinator', false],
      ['mcp', 'mcp.call-tool', false],
    ] as const) {
      const call = await startCapabilityCall({
        ...serverInput(coreDb),
        requestId: null,
        family,
        capabilityId,
      });
      const persistence = Promise.resolve().then(() =>
        persistLlmCapabilityCallSystemPromptDigest({
          workspaceDb: coreDb,
          callId: call.id,
          systemPromptDigest,
        })
      );
      if (eligible) await persistence;
      else await expect(persistence).rejects.toThrow();
      const retained = listServerCapabilityCalls(coreDb).find((row) => row.id === call.id);
      expect(retained).toBeDefined();
      if (eligible) expect(retained).toHaveProperty('systemPromptDigest', systemPromptDigest);
      else expect(retained).not.toHaveProperty('systemPromptDigest');
    }
    await expect(
      Promise.resolve().then(() =>
        persistLlmCapabilityCallSystemPromptDigest({
          workspaceDb: coreDb,
          callId: 'cap_00000000-0000-7000-8000-000000000001',
          systemPromptDigest,
        })
      )
    ).rejects.toThrow();
    expect(listServerCapabilityCalls(coreDb)).toHaveLength(4);
  } finally {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
