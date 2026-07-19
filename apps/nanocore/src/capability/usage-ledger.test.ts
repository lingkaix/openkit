import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  finishCapabilityCall,
  listWorkspaceCapabilityCalls,
  recordUsage,
  recoverRunningCapabilityCalls,
  startCapabilityCall,
} from './usage-ledger.js';

describe('capability usage ledger', () => {
  it('records a capability call before linked usage and terminal status', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const call = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: 'as_worker',
        authorityActor: { kind: 'user', id: 'user_ledger' },
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
        threadId: 'th_demo',
        turnId: 'turn_demo',
        workspaceDb,
        workspaceId: 'ws_demo',
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
      expect(listWorkspaceCapabilityCalls(workspaceDb, 'ws_demo')[0]).toMatchObject({
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
          thread_id: 'th_demo',
          turn_id: 'turn_demo',
          workspace_id: 'ws_demo',
        }),
      ]);
      expect(auditRows(workspaceDb, call.id)[0]).not.toHaveProperty('runtime_origin_ref');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('uses the same recorder lifecycle for LLM and MCP usage producers', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-producers-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const producers = [
        {
          authorityActor: { kind: 'user', id: 'user_gateway' } as const,
          capabilityId: 'llm.responses',
          category: 'llm' as const,
          family: 'llm' as const,
          operation: 'responses.create',
          providerRef: 'provider_anthropic',
          quantity: 12,
          requestId: '00000000-0000-4000-8000-000000000101',
          responsibleUserId: 'user_gateway',
          summary: 'LLM responses call',
          unit: 'tokens' as const,
        },
        {
          authorityActor: {
            kind: 'agent',
            id: 'agent_tool',
            responsibleUserId: 'user_tool_owner',
          } as const,
          capabilityId: 'mcp.github.issues.list',
          category: 'tool' as const,
          family: 'mcp' as const,
          operation: 'mcp.call_tool',
          providerRef: 'mcp.github',
          quantity: 1,
          requestId: '00000000-0000-4000-8000-000000000102',
          responsibleUserId: 'user_tool_owner',
          summary: 'MCP tool call',
          unit: 'tool_calls' as const,
        },
        {
          authorityActor: {
            kind: 'automation',
            id: 'automation_worker',
            responsibleUserId: 'user_worker_owner',
          } as const,
          capabilityId: 'runtime.worker_turn',
          category: 'runtime' as const,
          family: 'runtime' as const,
          operation: 'worker.checkpoint.terminal',
          providerRef: 'nanocore-runtime',
          quantity: 1,
          requestId: '00000000-0000-4000-8000-000000000103',
          responsibleUserId: 'user_worker_owner',
          summary: 'Worker turn runtime',
          unit: 'sandbox_sessions' as const,
        },
        {
          authorityActor: { kind: 'user', id: 'user_export' } as const,
          capabilityId: 'storage.workspace_export',
          category: 'storage' as const,
          family: 'storage' as const,
          operation: 'workspace.export.write',
          providerRef: 'nanocore-storage',
          quantity: 123,
          requestId: '00000000-0000-4000-8000-000000000104',
          responsibleUserId: 'user_export',
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
          workspaceId: 'ws_demo',
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      expect(() =>
        startCapabilityCall({
          authorityActor: { kind: 'user', id: 'user_ledger' },
          capabilityId: 'llm.responses',
          family: 'llm',
          operation: 'responses.create',
          redactionClass: 'metadata-only',
          summary: 'LLM responses call',
          workspaceDb,
          workspaceId: 'ws_demo',
          promptText: 'raw prompt',
        } as Parameters<typeof startCapabilityCall>[0] & { promptText: string })
      ).toThrow('Capability usage ledger values must be redacted before recording.');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('returns the existing call for the same request, family, and operation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-idem-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const first = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        callId: 'cap_first',
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000002',
        sourceIds: ['repo_beta', 'repo_alpha', 'repo_beta'],
        workspaceDb,
        workspaceId: 'ws_demo',
      });
      const second = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        callId: 'cap_second',
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000002',
        sourceIds: ['repo_alpha', 'repo_beta'],
        workspaceDb,
        workspaceId: 'ws_demo',
      });
      const count = workspaceDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM capability_calls')
        .get() as { count: number };

      expect(second.id).toBe(first.id);
      expect(count.count).toBe(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not collapse explicit call ids when request id is absent', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-null-request-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const first = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        callId: 'cap_runtime_first',
        capabilityId: 'runtime.worker_turn',
        family: 'runtime',
        operation: 'worker.checkpoint.terminal',
        redactionClass: 'metadata-only',
        workspaceDb,
        workspaceId: 'ws_demo',
      });
      const second = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        callId: 'cap_runtime_second',
        capabilityId: 'runtime.worker_turn',
        family: 'runtime',
        operation: 'worker.checkpoint.terminal',
        redactionClass: 'metadata-only',
        workspaceDb,
        workspaceId: 'ws_demo',
      });

      expect(first.id).toBe('cap_runtime_first');
      expect(second.id).toBe('cap_runtime_second');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects contradictory immutable attribution for an existing idempotency key', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-retry-conflict-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const original = {
        agentId: 'agent_original',
        agentSessionId: 'as_original',
        authorityActor: { kind: 'user', id: 'user_ledger' },
        callId: 'cap_original',
        capabilityId: 'llm.responses',
        family: 'llm',
        itemId: 'it_original',
        operation: 'responses.create',
        packageSnapshotId: 'aepsnap_original',
        providerRef: 'provider_original',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000003',
        runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
        runtimeOriginRef: `rto_${'a'.repeat(24)}`,
        serviceRef: 'service_original',
        sourceIds: ['repo_alpha', 'repo_beta'],
        threadId: 'th_original',
        turnId: 'turn_original',
        workspaceDb,
        workspaceId: 'ws_demo',
      } satisfies Parameters<typeof startCapabilityCall>[0];
      const first = startCapabilityCall(original);
      const originalRow = capabilityCallRow(workspaceDb, first.id);
      const contradictions = [
        ['capabilityId', { capabilityId: 'llm.chat-completions' }],
        ['threadId', { threadId: 'th_changed' }],
        ['turnId', { turnId: 'turn_changed' }],
        ['itemId', { itemId: 'it_changed' }],
        ['agentId', { agentId: 'agent_changed' }],
        ['agentSessionId', { agentSessionId: 'as_changed' }],
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000004',
        workspaceDb,
        workspaceId: 'ws_demo',
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
          workspace_id: 'ws_demo',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('does not duplicate terminal audit events when finish is retried', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-audit-retry-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000006',
        workspaceDb,
        workspaceId: 'ws_demo',
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

  it('records terminal audit events when running calls are recovered', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capability-ledger-audit-recovery-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: 'user_ledger' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: '00000000-0000-4000-8000-000000000007',
        workspaceDb,
        workspaceId: 'ws_demo',
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
          outcome: 'cancelled',
          severity: 'warning',
          workspace_id: 'ws_demo',
        }),
      ]);
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
