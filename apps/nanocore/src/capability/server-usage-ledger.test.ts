import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerCapabilityCallSchema, ServerUsageRecordSchema } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  finishCapabilityCall,
  listServerCapabilityCalls,
  listServerUsageRecords,
  recordUsage,
  recoverRunningCapabilityCalls,
  startCapabilityCall,
  writeGatewayRouteLineage,
} from './usage-ledger.js';

it('retains Server calls and measured usage in Core without a Workspace and recovers without replay', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-usage-'));
  let coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
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
    const call = startCapabilityCall(input);
    expect(startCapabilityCall(input)).toMatchObject({ id: call.id, inserted: false });
    expect(() =>
      startCapabilityCall({ ...input, turnId: 'tu_00000000-0000-7000-8000-000000000002' })
    ).toThrow('attribution conflicts');
    writeGatewayRouteLineage({
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
    const usageIds = recordUsage({ workspaceDb: coreDb, call, records, now: input.now });
    expect(recordUsage({ workspaceDb: coreDb, call, records, now: input.now })).toEqual(usageIds);
    finishCapabilityCall({
      workspaceDb: coreDb,
      callId: call.id,
      status: 'succeeded',
      now: input.now,
    });
    const [retained] = listServerCapabilityCalls(coreDb);
    const [usage] = listServerUsageRecords(coreDb);
    expect(ServerCapabilityCallSchema.parse(retained)).toMatchObject({
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
    for (const table of ['capability_calls', 'usage_records'])
      expect(() =>
        coreDb.sqlite
          .prepare(`UPDATE ${table} SET workspace_id = ?`)
          .run('ws_00000000-0000-7000-8000-000000000001')
      ).toThrow('CHECK constraint failed');
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
    const pending = startCapabilityCall({ ...input, requestId: null });
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    expect(recoverRunningCapabilityCalls({ workspaceDb: coreDb, now: input.now })).toBe(1);
    expect(
      listServerCapabilityCalls(coreDb).find((entry) => entry.id === pending.id)
    ).toMatchObject({ status: 'unknown', errorCode: 'capability_call_recovered_after_restart' });
    expect(listServerUsageRecords(coreDb)).toHaveLength(1);
  } finally {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
