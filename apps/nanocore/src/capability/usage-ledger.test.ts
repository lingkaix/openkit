import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  finishCapabilityCall,
  importWorkspaceCapabilityUsageLedger,
  listWorkspaceCapabilityCalls,
  readLatestCurrentAgentSessionLlmUsage,
  recordUsage,
  recoverRunningCapabilityCalls,
  startCapabilityCall,
  writeGatewayRouteLineage,
} from './usage-ledger.js';

describe('capability usage ledger', () => {
  it('records a capability call before linked usage and terminal status', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const call = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: 'as_00000000-0000-78f3-a236-d324525fc901',
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        capabilityId: 'llm.responses',
        family: 'llm',
        itemId: null,
        operation: 'responses.create',
        packageSnapshotId: 'aepsnap_demo',
        providerRef: 'provider_openai',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000001',
        runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
        runtimeOriginRef: `rto_${'a'.repeat(24)}`,
        serviceRef: null,
        sourceIds: ['repo_default'],
        summary: 'LLM responses call',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      recordUsage({
        workspaceDb,
        call,
        records: [
          {
            category: 'llm',
            modelId: 'gpt-5',
            providerRef: 'provider_openai',
            quantity: 42,
            source: 'provider-reported',
            unit: 'tokens',
          },
        ],
        now: new Date('2026-07-05T00:00:01.000Z'),
      });
      finishCapabilityCall({
        workspaceDb,
        callId: call.id,
        status: 'succeeded',
        now: new Date('2026-07-05T00:00:02.000Z'),
      });

      expect(capabilityCallRow(workspaceDb, call.id)).toMatchObject({
        call_id: call.id,
        capability_id: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        package_snapshot_id: 'aepsnap_demo',
        runtime_cache_lineage_ref: `rcl_${'b'.repeat(24)}`,
        runtime_origin_ref: `rto_${'a'.repeat(24)}`,
        source_ids_json: '["repo_default"]',
        status: 'succeeded',
      });
      expect(usageRows(workspaceDb, call.id)).toEqual([
        expect.objectContaining({
          capability_call_id: call.id,
          category: 'llm',
          model_id: 'gpt-5',
          provider_ref: 'provider_openai',
          quantity: 42,
          source_ids_json: '["repo_default"]',
          unit: 'tokens',
        }),
      ]);
      expect(
        listWorkspaceCapabilityCalls(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')[0]
      ).toMatchObject({
        packageSnapshotId: 'aepsnap_demo',
        runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
        runtimeOriginRef: `rto_${'a'.repeat(24)}`,
      });
      expect(usageRows(workspaceDb, call.id)[0]).not.toHaveProperty('package_snapshot_id');
      expect(auditRows(workspaceDb, call.id)).toEqual([
        expect.objectContaining({
          action: 'capability.finish',
          capability_call_id: call.id,
          category: 'capability',
          created_at: '2026-07-05T00:00:02.000Z',
          error_code: null,
          outcome: 'succeeded',
          request_id: '00000000-0000-4000-8000-000000000001',
          resource: 'capability:llm.responses',
          severity: 'info',
          summary: 'Capability call succeeded: LLM responses call',
          thread_id: 'th_00000000-0000-7000-8000-000000000001',
          turn_id: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
        }),
      ]);
      expect(auditRows(workspaceDb, call.id)[0]).not.toHaveProperty('runtime_origin_ref');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('keeps fresh null-request inference calls and usage separate under one command audit lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-command-audit-rounds-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const auditLineage = { commandRequestId: '00000000-0000-4000-8000-000000000401' };
      const calls = [];
      const usageIds = [];

      for (let round = 0; round < 2; round += 1) {
        const call = startCapabilityCall({
          authorityActor: { kind: 'user', id: 'user_ledger' },
          capabilityId: 'llm.responses',
          family: 'llm',
          operation: 'responses.create',
          redactionClass: 'metadata-only',
          requestId: null,
          threadId: 'th_command',
          turnId: 'turn_command',
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        });
        calls.push(call);
        const usageInput = {
          auditLineage,
          call,
          records: [{ category: 'llm' as const, quantity: 12, unit: 'tokens' as const }],
          workspaceDb,
        };
        usageIds.push(recordUsage(usageInput));
        const finishInput = {
          auditLineage,
          callId: call.id,
          status: 'succeeded' as const,
          workspaceDb,
        };
        finishCapabilityCall(finishInput);
      }

      expect(calls[0].inserted).toBe(true);
      expect(calls[1].inserted).toBe(true);
      expect(calls[0].id).not.toBe(calls[1].id);
      expect(usageIds[0]).toHaveLength(1);
      expect(usageIds[1]).toHaveLength(1);
      expect(usageIds[0][0]).not.toBe(usageIds[1][0]);
      expect(
        listWorkspaceCapabilityCalls(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(2);
      for (const [index, call] of calls.entries()) {
        expect(capabilityCallRow(workspaceDb, call.id)).toMatchObject({
          request_id: null,
          status: 'succeeded',
          thread_id: 'th_command',
          turn_id: 'turn_command',
          workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
        });
        expect(usageRows(workspaceDb, call.id)).toEqual([
          expect.objectContaining({
            capability_call_id: call.id,
            category: 'llm',
            quantity: 12,
            request_id: null,
            responsible_user_id: 'user_ledger',
            thread_id: 'th_command',
            turn_id: 'turn_command',
            unit: 'tokens',
            usage_id: usageIds[index][0],
            workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
          }),
        ]);
      }
      for (const call of calls) {
        expect(auditRows(workspaceDb, call.id)).toEqual([
          expect.objectContaining({
            action: 'capability.finish',
            capability_call_id: call.id,
            outcome: 'succeeded',
            request_id: auditLineage.commandRequestId,
            thread_id: 'th_command',
            turn_id: 'turn_command',
            workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
          }),
        ]);
      }
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'uses command audit lineage for a failed null-request call',
      requestId: null,
      auditLineage: { commandRequestId: '00000000-0000-4000-8000-000000000402' },
      status: 'failed' as const,
      expectedRequestId: '00000000-0000-4000-8000-000000000402',
    },
    {
      name: 'keeps a null audit request when no command lineage is available',
      requestId: null,
      auditLineage: undefined,
      status: 'succeeded' as const,
      expectedRequestId: null,
    },
    {
      name: 'keeps the stored request ahead of a different command audit lineage',
      requestId: '00000000-0000-4000-8000-000000000403',
      auditLineage: { commandRequestId: '00000000-0000-4000-8000-000000000404' },
      status: 'succeeded' as const,
      expectedRequestId: '00000000-0000-4000-8000-000000000403',
    },
  ])('$name', ({ requestId, auditLineage, status, expectedRequestId }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-command-audit-finish-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId,
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const errorCode = status === 'failed' ? 'provider_failed' : null;
      const finishInput = { auditLineage, callId: call.id, errorCode, status, workspaceDb };
      finishCapabilityCall(finishInput);

      expect(capabilityCallRow(workspaceDb, call.id)).toMatchObject({
        error_code: errorCode,
        request_id: requestId,
        status,
      });
      expect(auditRows(workspaceDb, call.id)).toEqual([
        expect.objectContaining({
          action: 'capability.finish',
          capability_call_id: call.id,
          error_code: errorCode,
          outcome: status,
          request_id: expectedRequestId,
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps command audit lineage when usage recording fails for a null-request call', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-command-audit-usage-failure-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: null,
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const auditLineage = { commandRequestId: '00000000-0000-4000-8000-000000000405' };
      const usageInput = {
        auditLineage,
        call,
        records: [{ category: 'llm' as const, quantity: -1, unit: 'tokens' as const }],
        workspaceDb,
      };

      expect(() => recordUsage(usageInput)).toThrow();
      expect(capabilityCallRow(workspaceDb, call.id)).toMatchObject({
        error_code: 'usage_record_failed',
        request_id: null,
        status: 'failed',
      });
      expect(usageRows(workspaceDb, call.id)).toEqual([]);
      expect(auditRows(workspaceDb, call.id)).toEqual([
        expect.objectContaining({
          action: 'capability.finish',
          capability_call_id: call.id,
          error_code: 'usage_record_failed',
          outcome: 'failed',
          request_id: auditLineage.commandRequestId,
          severity: 'error',
          summary: 'Capability call failed: usage_record_failed',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rejects malformed command audit lineage without terminal or audit mutation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-command-audit-invalid-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: null,
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const before = capabilityCallRow(workspaceDb, call.id);
      const finishInput = {
        auditLineage: { commandRequestId: 'invalid-request-id' },
        callId: call.id,
        status: 'succeeded' as const,
        workspaceDb,
      };

      expect(() => finishCapabilityCall(finishInput)).toThrow();
      expect(capabilityCallRow(workspaceDb, call.id)).toEqual(before);
      expect(auditRows(workspaceDb, call.id)).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('uses the same recorder lifecycle for LLM and MCP usage producers', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-producers-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const producers = [
        {
          authorityActor: { kind: 'user', id: 'usr_00000000-0000-728a-a463-9175ccb87084' } as const,
          capabilityId: 'llm.responses',
          category: 'llm' as const,
          family: 'llm' as const,
          operation: 'responses.create',
          providerRef: 'provider_anthropic',
          quantity: 12,
          requestId: '00000000-0000-4000-8000-000000000101',
          responsibleUserId: 'usr_00000000-0000-728a-a463-9175ccb87084',
          summary: 'LLM responses call',
          unit: 'tokens' as const,
        },
        {
          authorityActor: {
            kind: 'agent',
            id: 'agent_tool',
            responsibleUserId: 'usr_00000000-0000-7f8b-b50f-3f66b3a218da',
          } as const,
          capabilityId: 'mcp.github.issues.list',
          category: 'tool' as const,
          family: 'mcp' as const,
          operation: 'mcp.call_tool',
          providerRef: 'mcp.github',
          quantity: 1,
          requestId: '00000000-0000-4000-8000-000000000102',
          responsibleUserId: 'usr_00000000-0000-7f8b-b50f-3f66b3a218da',
          summary: 'MCP tool call',
          unit: 'tool_calls' as const,
        },
        {
          authorityActor: {
            kind: 'automation',
            id: 'auto_00000000-0000-7724-8c5f-4aaaae6b3253',
            responsibleUserId: 'usr_00000000-0000-7f8f-994a-d63f593d1d0e',
          } as const,
          capabilityId: 'runtime.worker_turn',
          category: 'runtime' as const,
          family: 'runtime' as const,
          operation: 'worker.checkpoint.terminal',
          providerRef: 'nanocore-runtime',
          quantity: 1,
          requestId: '00000000-0000-4000-8000-000000000103',
          responsibleUserId: 'usr_00000000-0000-7f8f-994a-d63f593d1d0e',
          summary: 'Worker turn runtime',
          unit: 'sandbox_sessions' as const,
        },
        {
          authorityActor: { kind: 'user', id: 'usr_00000000-0000-775c-a38b-92e90ebbce3f' } as const,
          capabilityId: 'storage.workspace_export',
          category: 'storage' as const,
          family: 'storage' as const,
          operation: 'workspace.export.write',
          providerRef: 'nanocore-storage',
          quantity: 123,
          requestId: '00000000-0000-4000-8000-000000000104',
          responsibleUserId: 'usr_00000000-0000-775c-a38b-92e90ebbce3f',
          summary: 'Workspace export storage',
          unit: 'bytes' as const,
        },
        {
          authorityActor: null,
          capabilityId: 'runtime.server_diagnostic',
          category: 'runtime' as const,
          family: 'runtime' as const,
          operation: 'diagnostic.observe',
          providerRef: 'nanocore-runtime',
          quantity: 1,
          requestId: '00000000-0000-4000-8000-000000000105',
          responsibleUserId: null,
          summary: 'Server diagnostic measurement',
          unit: 'requests' as const,
        },
      ];

      for (const producer of producers) {
        const call = startCapabilityCall({
          authorityActor: producer.authorityActor,
          capabilityId: producer.capabilityId,
          family: producer.family,
          operation: producer.operation,
          providerRef: producer.providerRef,
          redactionClass: 'metadata-only',
          requestId: producer.requestId,
          summary: producer.summary,
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        });

        recordUsage({
          call,
          records: [
            {
              category: producer.category,
              providerRef: producer.providerRef,
              quantity: producer.quantity,
              source: 'gateway-reported',
              unit: producer.unit,
            },
          ],
          workspaceDb,
        });
        finishCapabilityCall({ callId: call.id, status: 'succeeded', workspaceDb });

        expect(capabilityCallRow(workspaceDb, call.id)).toMatchObject({
          capability_id: producer.capabilityId,
          family: producer.family,
          operation: producer.operation,
          provider_ref: producer.providerRef,
          status: 'succeeded',
        });
        expect(usageRows(workspaceDb, call.id)).toEqual([
          expect.objectContaining({
            capability_call_id: call.id,
            category: producer.category,
            provider_ref: producer.providerRef,
            quantity: producer.quantity,
            responsible_user_id: producer.responsibleUserId,
            unit: producer.unit,
          }),
        ]);
        expect(auditRows(workspaceDb, call.id)).toEqual([
          expect.objectContaining({
            action: 'capability.finish',
            capability_call_id: call.id,
            outcome: 'succeeded',
            resource: `capability:${producer.capabilityId}`,
          }),
        ]);
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects raw payload fields before they reach ledger rows', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-leak-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      expect(() =>
        startCapabilityCall({
          authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
          capabilityId: 'llm.responses',
          family: 'llm',
          operation: 'responses.create',
          redactionClass: 'metadata-only',
          summary: 'LLM responses call',
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          promptText: 'raw prompt',
        } as Parameters<typeof startCapabilityCall>[0] & { promptText: string })
      ).toThrow('Capability usage ledger values must be redacted before recording.');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('returns the existing call for the same request, family, and operation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-idem-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const first = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-75dc-aab7-3ea61262bb7c',
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000002',
        sourceIds: ['repo_beta', 'repo_alpha', 'repo_beta'],
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const second = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-782e-9bd8-eead654ad5df',
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000002',
        sourceIds: ['repo_alpha', 'repo_beta'],
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const count = workspaceDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM capability_calls')
        .get() as { count: number };

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.id).toBe(first.id);
      expect(count.count).toBe(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not collapse explicit call ids when request id is absent', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-null-request-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const first = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-7967-bbe1-240c056d5680',
        capabilityId: 'runtime.worker_turn',
        family: 'runtime',
        operation: 'worker.checkpoint.terminal',
        redactionClass: 'metadata-only',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const second = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-79e7-a10b-a6c8afb658be',
        capabilityId: 'runtime.worker_turn',
        family: 'runtime',
        operation: 'worker.checkpoint.terminal',
        redactionClass: 'metadata-only',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      expect(first.id).toBe('cap_00000000-0000-7967-bbe1-240c056d5680');
      expect(second.id).toBe('cap_00000000-0000-79e7-a10b-a6c8afb658be');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects contradictory immutable attribution for an existing idempotency key', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-retry-conflict-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const original = {
        agentId: 'agent_original',
        agentSessionId: 'as_00000000-0000-7faf-b418-a0c597b4f6e7',
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-78ea-a8de-37d996fac033',
        capabilityId: 'llm.responses',
        family: 'llm',
        itemId: 'it_00000000-0000-7d59-ae27-86232be930df',
        operation: 'responses.create',
        packageSnapshotId: 'aepsnap_original',
        providerRef: 'provider_original',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000003',
        runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
        runtimeOriginRef: `rto_${'a'.repeat(24)}`,
        serviceRef: 'service_original',
        sourceIds: ['repo_alpha', 'repo_beta'],
        threadId: 'th_00000000-0000-7199-a5ff-a91caa94c760',
        turnId: 'tu_00000000-0000-769a-aad2-333c7165615f',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      } satisfies Parameters<typeof startCapabilityCall>[0];
      const first = startCapabilityCall(original);
      const originalRow = capabilityCallRow(workspaceDb, first.id);
      const contradictions = [
        ['capabilityId', { capabilityId: 'llm.chat-completions' }],
        ['threadId', { threadId: 'th_00000000-0000-7295-b429-158628e64e61' }],
        ['turnId', { turnId: 'tu_00000000-0000-7fb5-91ee-02fe963f55ef' }],
        ['itemId', { itemId: 'it_00000000-0000-7527-9063-a3fdbfca2a0c' }],
        ['agentId', { agentId: 'agent_changed' }],
        ['agentSessionId', { agentSessionId: 'as_00000000-0000-7db5-b42a-ada5722461c5' }],
        ['packageSnapshotId', { packageSnapshotId: 'aepsnap_changed' }],
        ['runtimeOriginRef', { runtimeOriginRef: `rto_${'c'.repeat(24)}` }],
        ['runtimeCacheLineageRef', { runtimeCacheLineageRef: `rcl_${'d'.repeat(24)}` }],
        ['sourceIds', { sourceIds: ['repo_alpha', 'repo_changed'] }],
        ['providerRef', { providerRef: 'provider_changed' }],
        ['serviceRef', { serviceRef: 'service_changed' }],
        ['redactionClass', { redactionClass: 'aggregate-only' }],
      ] satisfies ReadonlyArray<
        readonly [string, Partial<Parameters<typeof startCapabilityCall>[0]>]
      >;

      for (const [field, contradiction] of contradictions) {
        expect(
          () =>
            startCapabilityCall({
              ...original,
              ...contradiction,
              callId: `cap_changed_${field}`,
            }),
          `${field} contradiction must fail closed`
        ).toThrow();
        expect(
          workspaceDb.sqlite.prepare('SELECT * FROM capability_calls ORDER BY call_id').all(),
          `${field} contradiction must not change the ledger`
        ).toEqual([originalRow]);
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('marks the capability call failed when usage recording fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-usage-failure-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000004',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      expect(() =>
        recordUsage({
          call,
          records: [
            {
              category: 'llm',
              quantity: -1,
              unit: 'tokens',
            },
          ],
          workspaceDb,
        })
      ).toThrow();
      expect(capabilityCallRow(workspaceDb, call.id)).toMatchObject({
        error_code: 'usage_record_failed',
        status: 'failed',
      });
      expect(auditRows(workspaceDb, call.id)).toEqual([
        expect.objectContaining({
          action: 'capability.finish',
          capability_call_id: call.id,
          category: 'capability',
          error_code: 'usage_record_failed',
          outcome: 'failed',
          resource: 'capability:llm.responses',
          severity: 'error',
          summary: 'Capability call failed: usage_record_failed',
          workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not duplicate terminal audit events when finish is retried', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-audit-retry-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        now: new Date('2026-07-05T00:00:01.000Z'),
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000006',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      finishCapabilityCall({
        callId: call.id,
        now: new Date('2026-07-05T00:00:02.000Z'),
        status: 'succeeded',
        workspaceDb,
      });
      finishCapabilityCall({
        callId: call.id,
        now: new Date('2026-07-05T00:00:03.000Z'),
        status: 'succeeded',
        workspaceDb,
      });

      expect(auditRows(workspaceDb, call.id)).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('atomically terminalizes calls and recovers uncertain effects as unknown', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-terminal-truth-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const rejected = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-7e1a-8e69-82f38a3844c2',
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        now: new Date('2026-07-05T00:00:03.000Z'),
        redactionClass: 'metadata-only',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      workspaceDb.sqlite.exec(
        `CREATE TRIGGER reject_capability_finish_audit
         BEFORE INSERT ON audit_events
         WHEN NEW.capability_call_id = '${rejected.id}'
         BEGIN
           SELECT RAISE(ABORT, 'injected audit failure');
         END`
      );

      expect(() =>
        finishCapabilityCall({
          callId: rejected.id,
          errorCode: 'provider_failed',
          status: 'failed',
          workspaceDb,
        })
      ).toThrow('injected audit failure');
      expect(capabilityCallRow(workspaceDb, rejected.id)).toMatchObject({
        completed_at: null,
        status: 'running',
      });
      expect(auditRows(workspaceDb, rejected.id)).toEqual([]);

      workspaceDb.sqlite.exec('DROP TRIGGER reject_capability_finish_audit');
      const uncertain = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-7926-b356-5a41d8af7efb',
        capabilityId: 'mcp.probe.echo',
        family: 'mcp',
        operation: 'mcp.call_tool',
        redactionClass: 'metadata-only',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      expect(recoverRunningCapabilityCalls({ workspaceDb })).toBe(2);
      expect(capabilityCallRow(workspaceDb, uncertain.id)).toMatchObject({
        error_code: 'capability_call_recovered_after_restart',
        status: 'unknown',
      });
      expect(auditRows(workspaceDb, uncertain.id)).toEqual([
        expect.objectContaining({ outcome: 'unknown', severity: 'warning' }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records terminal audit events when running calls are recovered', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-audit-recovery-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        now: new Date('2026-07-05T00:00:03.000Z'),
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000007',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      expect(
        recoverRunningCapabilityCalls({
          now: new Date('2026-07-05T00:00:04.000Z'),
          workspaceDb,
        })
      ).toBe(1);
      expect(auditRows(workspaceDb, call.id)).toEqual([
        expect.objectContaining({
          action: 'capability.finish',
          capability_call_id: call.id,
          category: 'capability',
          created_at: '2026-07-05T00:00:04.000Z',
          error_code: 'capability_call_recovered_after_restart',
          outcome: 'unknown',
          severity: 'warning',
          workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('reads only current-session category llm usage joined to a family llm call', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-current-session-llm-usage-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const current = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: 'as_00000000-0000-777a-9b6e-9393a5c0d8cf',
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-7682-9329-8d28c3eddeef',
        capabilityId: 'llm.responses',
        family: 'llm',
        now: new Date('2026-09-17T02:00:00.000Z'),
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000301',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7e2b-8908-a810d8216ae9',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      recordUsage({
        call: current,
        now: new Date('2026-09-17T02:00:01.000Z'),
        records: [
          {
            category: 'llm',
            modelId: 'openai/gpt-current',
            quantity: 3,
            unit: 'tokens',
            usageId: 'use_00000000-0000-720e-a059-ea2496d083a3',
          },
        ],
        workspaceDb,
      });
      const predecessor = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: 'as_00000000-0000-7566-bb3c-0c317df86f2e',
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-70c7-8f0b-db044f2644fa',
        capabilityId: 'llm.responses',
        family: 'llm',
        now: new Date('2026-09-17T02:00:02.000Z'),
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000302',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7f9f-ae1e-82292b6a8d60',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      recordUsage({
        call: predecessor,
        now: new Date('2026-09-17T02:00:03.000Z'),
        records: [
          {
            category: 'llm',
            modelId: 'openai/gpt-predecessor',
            quantity: 5,
            unit: 'tokens',
            usageId: 'use_00000000-0000-7dc9-9cba-0a11208bcfd3',
          },
        ],
        workspaceDb,
      });
      const mismatchedFamily = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: 'as_00000000-0000-777a-9b6e-9393a5c0d8cf',
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7df3-b5b9-11c153cab432' },
        callId: 'cap_00000000-0000-7142-9de8-c6b18db70896',
        capabilityId: 'mcp.call',
        family: 'mcp',
        now: new Date('2026-09-17T02:00:04.000Z'),
        operation: 'mcp.call_tool',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000303',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7e2b-8908-a810d8216ae9',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      recordUsage({
        call: mismatchedFamily,
        now: new Date('2026-09-17T02:00:05.000Z'),
        records: [
          {
            category: 'llm',
            modelId: 'openai/gpt-mcp-family',
            quantity: 1,
            unit: 'tokens',
            usageId: 'use_00000000-0000-76a5-ad4e-fb2392f232f0',
          },
        ],
        workspaceDb,
      });

      expect(
        readLatestCurrentAgentSessionLlmUsage(workspaceDb, {
          agentSessionId: 'as_00000000-0000-777a-9b6e-9393a5c0d8cf',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).toEqual({
        capabilityCallId: 'cap_00000000-0000-7682-9329-8d28c3eddeef',
        modelId: 'openai/gpt-current',
        recordedAt: '2026-09-17T02:00:01.000Z',
        turnId: 'tu_00000000-0000-7e2b-8908-a810d8216ae9',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

/**
 * Reads one capability call row by id.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param callId Capability call id.
 * @returns Raw capability call row.
 */
function capabilityCallRow(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  callId: string
): Record<string, unknown> {
  return workspaceDb.sqlite
    .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
    .get(callId) as Record<string, unknown>;
}

/**
 * Reads usage rows linked to one capability call.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param callId Capability call id.
 * @returns Raw usage rows.
 */
function usageRows(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  callId: string
): Array<Record<string, unknown>> {
  return workspaceDb.sqlite
    .prepare('SELECT * FROM usage_records WHERE capability_call_id = ? ORDER BY usage_id')
    .all(callId) as Array<Record<string, unknown>>;
}

/**
 * Reads audit rows linked to one capability call.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param callId Capability call id.
 * @returns Raw audit rows.
 */
function auditRows(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  callId: string
): Array<Record<string, unknown>> {
  return workspaceDb.sqlite
    .prepare('SELECT * FROM audit_events WHERE capability_call_id = ? ORDER BY created_at')
    .all(callId) as Array<Record<string, unknown>>;
}

describe('retained call digest round-trip', () => {
  it('exports then imports a digest and preserves absence on an old row', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-digest-transfer-'));
    const source = openWorkspaceDb(dataRoot, 'ws_00000000-0000-71b1-9af2-985861a05396');
    const target = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7b16-81e5-c0b623c0c636');
    try {
      applyScopedMigrations(source);
      applyScopedMigrations(target);
      for (const callId of [
        'cap_00000000-0000-7409-878a-46cfc62378f7',
        'cap_00000000-0000-7ff2-b713-d35db1d00ca0',
      ]) {
        startCapabilityCall({
          workspaceDb: source,
          workspaceId: 'ws_00000000-0000-71b1-9af2-985861a05396',
          authorityActor: null,
          capabilityId: 'llm.responses',
          family: 'llm',
          operation: 'responses',
          redactionClass: 'metadata-only',
          callId,
        });
      }
      const digest = `sha256:${'a'.repeat(64)}`;
      source.sqlite
        .prepare('UPDATE capability_calls SET system_prompt_digest = ? WHERE call_id = ?')
        .run(digest, 'cap_00000000-0000-7409-878a-46cfc62378f7');
      const exported = JSON.parse(
        JSON.stringify(
          listWorkspaceCapabilityCalls(source, 'ws_00000000-0000-71b1-9af2-985861a05396')
        )
      );
      importWorkspaceCapabilityUsageLedger({
        workspaceDb: target,
        capabilityCalls: exported.map((call: Record<string, unknown>) => ({
          ...call,
          workspaceId: 'ws_00000000-0000-7b16-81e5-c0b623c0c636',
        })),
        usageRecords: [],
      });
      expect(
        listWorkspaceCapabilityCalls(target, 'ws_00000000-0000-7b16-81e5-c0b623c0c636').find(
          (call) => call.id === 'cap_00000000-0000-7409-878a-46cfc62378f7'
        )?.systemPromptDigest
      ).toBe(digest);
      expect(
        listWorkspaceCapabilityCalls(target, 'ws_00000000-0000-7b16-81e5-c0b623c0c636').find(
          (call) => call.id === 'cap_00000000-0000-7ff2-b713-d35db1d00ca0'
        )
      ).not.toHaveProperty('systemPromptDigest');
      expect(
        listWorkspaceCapabilityCalls(target, 'ws_00000000-0000-7b16-81e5-c0b623c0c636').find(
          (call) => call.id === 'cap_00000000-0000-7ff2-b713-d35db1d00ca0'
        )
      ).not.toHaveProperty('extensions');
      expect(
        target.sqlite
          .prepare('SELECT extensions_json FROM capability_calls WHERE call_id = ?')
          .get('cap_00000000-0000-7ff2-b713-d35db1d00ca0')
      ).toEqual({ extensions_json: null });
      expect(
        target.sqlite
          .prepare('SELECT system_prompt_digest FROM capability_calls WHERE call_id = ?')
          .get('cap_00000000-0000-7409-878a-46cfc62378f7')
      ).toEqual({ system_prompt_digest: digest });
    } finally {
      source.sqlite.close();
      target.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('Gateway lineage recovery', () => {
  it('keeps committed unknown attempt evidence when a running call is recovered', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-lineage-recovery-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7849-b543-b73e540db459');
    try {
      applyScopedMigrations(workspaceDb);
      const call = startCapabilityCall({
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7849-b543-b73e540db459',
        authorityActor: null,
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses',
        redactionClass: 'metadata-only',
      });
      writeGatewayRouteLineage({
        workspaceDb,
        call,
        logicalModelId: 'tier',
        entry: {
          kind: 'attempt',
          routeMemberId: 'primary',
          providerProfileId: 'p',
          providerModel: 'gpt-5.1',
          selectionReason: 'primary',
          attemptOrder: 0,
          retryIndex: 0,
          outputBegan: false,
          terminalResult: 'unknown',
        },
      });
      const before = workspaceDb.sqlite
        .prepare('SELECT extensions_json FROM capability_calls')
        .get();
      expect(recoverRunningCapabilityCalls({ workspaceDb })).toBe(1);
      expect(
        workspaceDb.sqlite.prepare('SELECT extensions_json FROM capability_calls').get()
      ).toEqual(before);
      expect(
        listWorkspaceCapabilityCalls(workspaceDb, 'ws_00000000-0000-7849-b543-b73e540db459')[0]
      ).toMatchObject({
        status: 'unknown',
        extensions: {
          'openkit.gateway/routeLineage': {
            entries: [{ terminalResult: 'unknown', outputBegan: false }],
          },
        },
      });
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('slice 1d round 2 canonical extension rewrite', () => {
  it('keeps another stored namespace while validating and updating its owned namespace', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'canonical-extensions-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7993-ac5a-37822c1bf7ab');
    try {
      applyScopedMigrations(workspaceDb);
      const call = startCapabilityCall({
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7993-ac5a-37822c1bf7ab',
        authorityActor: null,
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses',
        redactionClass: 'metadata-only',
      });
      const other = { label: 'retained', nested: [false, 0, null] };
      workspaceDb.sqlite
        .prepare('UPDATE capability_calls SET extensions_json = ? WHERE call_id = ?')
        .run(JSON.stringify({ 'future.example/evidence': other }), call.id);
      const entry = {
        kind: 'attempt' as const,
        routeMemberId: 'primary',
        providerProfileId: 'p',
        providerModel: 'native',
        selectionReason: 'primary',
        attemptOrder: 0,
        retryIndex: 0,
        outputBegan: false,
        terminalResult: 'unknown' as const,
      };
      writeGatewayRouteLineage({ workspaceDb, call, logicalModelId: 'tier', entry });
      const read = () =>
        JSON.parse(
          (
            workspaceDb.sqlite
              .prepare('SELECT extensions_json FROM capability_calls WHERE call_id = ?')
              .get(call.id) as { extensions_json: string }
          ).extensions_json
        );
      expect(read()['future.example/evidence']).toEqual(other);
      expect(() =>
        writeGatewayRouteLineage({
          workspaceDb,
          call,
          logicalModelId: 'tier',
          entry: { ...entry, failureKind: 'new_kind' as never },
        })
      ).toThrow();
      expect(read()['future.example/evidence']).toEqual(other);
      expect(read()['openkit.gateway/routeLineage'].entries).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
