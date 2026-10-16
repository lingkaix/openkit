import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { GatewayUsageTracker, parseUsage, recordInternalLlmGatewayUsage } from './gateway-usage.js';

/**
 * Creates a provider config suitable for usage-tracker tests.
 *
 * @returns Resolved provider config.
 */
function providerConfig(): ResolvedLLMProviderConfig {
  return {
    adapterId: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.test/v1',
    displayName: 'OpenAI',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    id: 'openai',
    models: ['gpt-test'],
    requiresApiKey: true,
  };
}

describe('recordInternalLlmGatewayUsage audit lineage', () => {
  it.each([
    {
      name: 'retains command audit lineage when the call request is null',
      requestId: null,
      auditLineage: { commandRequestId: '00000000-0000-4000-8000-000000000501' },
      expectedRequestId: '00000000-0000-4000-8000-000000000501',
    },
    {
      name: 'keeps the audit request null without command lineage',
      requestId: null,
      auditLineage: undefined,
      expectedRequestId: null,
    },
    {
      name: 'retains the stored request without command lineage',
      requestId: '00000000-0000-4000-8000-000000000502',
      auditLineage: undefined,
      expectedRequestId: '00000000-0000-4000-8000-000000000502',
    },
    {
      name: 'keeps the stored request ahead of conflicting command lineage',
      requestId: '00000000-0000-4000-8000-000000000503',
      auditLineage: { commandRequestId: '00000000-0000-4000-8000-000000000504' },
      expectedRequestId: '00000000-0000-4000-8000-000000000503',
    },
  ])('$name after a usage write failure', ({ requestId, auditLineage, expectedRequestId }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-internal-usage-failure-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: testEntityId('usr', 'user_usage') },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId,
        threadId: testEntityId('th', 'th_usage'),
        turnId: testEntityId('tu', 'turn_usage'),
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      workspaceDb.sqlite.exec(`
        CREATE TRIGGER reject_internal_usage_write
        BEFORE INSERT ON usage_records
        BEGIN
          SELECT RAISE(ABORT, 'injected internal usage write failure');
        END
      `);
      const input = {
        ...(auditLineage === undefined ? {} : { auditLineage }),
        call,
        logicalModelId: 'logical_test',
        providerId: 'provider_test',
        succeeded: true,
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
        workspaceDb,
      };

      expect(() => recordInternalLlmGatewayUsage(input)).toThrow(
        'injected internal usage write failure'
      );
      expect(
        workspaceDb.sqlite.prepare('SELECT * FROM capability_calls WHERE call_id = ?').get(call.id)
      ).toMatchObject({
        error_code: 'usage_record_failed',
        request_id: requestId,
        status: 'failed',
        thread_id: testEntityId('th', 'th_usage'),
        turn_id: testEntityId('tu', 'turn_usage'),
        workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
      });
      expect(
        workspaceDb.sqlite
          .prepare('SELECT * FROM usage_records WHERE capability_call_id = ?')
          .all(call.id)
      ).toEqual([]);
      expect(
        workspaceDb.sqlite
          .prepare('SELECT * FROM audit_events WHERE capability_call_id = ?')
          .all(call.id)
      ).toEqual([
        expect.objectContaining({
          action: 'capability.finish',
          capability_call_id: call.id,
          error_code: 'usage_record_failed',
          outcome: 'failed',
          request_id: expectedRequestId,
          severity: 'error',
          thread_id: testEntityId('th', 'th_usage'),
          turn_id: testEntityId('tu', 'turn_usage'),
          workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps command lineage out of normal usage and the call request', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-internal-usage-success-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const call = startCapabilityCall({
        authorityActor: { kind: 'user', id: testEntityId('usr', 'user_usage') },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses.create',
        redactionClass: 'metadata-only',
        requestId: null,
        threadId: testEntityId('th', 'th_usage'),
        turnId: testEntityId('tu', 'turn_usage'),
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const before = workspaceDb.sqlite
        .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
        .get(call.id);
      const input = {
        auditLineage: { commandRequestId: '00000000-0000-4000-8000-000000000505' },
        call,
        logicalModelId: 'logical_test',
        providerId: 'provider_test',
        succeeded: true,
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
        workspaceDb,
      };

      const usageIds = recordInternalLlmGatewayUsage(input);

      expect(usageIds).toHaveLength(1);
      expect(
        workspaceDb.sqlite
          .prepare('SELECT * FROM usage_records WHERE capability_call_id = ?')
          .all(call.id)
      ).toEqual([
        expect.objectContaining({
          capability_call_id: call.id,
          category: 'llm',
          model_id: 'logical_test',
          provider_ref: 'provider_test',
          quantity: 12,
          request_id: null,
          source: 'gateway-reported',
          thread_id: testEntityId('th', 'th_usage'),
          turn_id: testEntityId('tu', 'turn_usage'),
          unit: 'tokens',
          usage_id: usageIds[0],
          workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
        }),
      ]);
      expect(
        workspaceDb.sqlite.prepare('SELECT * FROM capability_calls WHERE call_id = ?').get(call.id)
      ).toEqual(before);
      expect(
        workspaceDb.sqlite
          .prepare('SELECT * FROM audit_events WHERE capability_call_id = ?')
          .all(call.id)
      ).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('GatewayUsageTracker', () => {
  it('retains raw pi-ai cache-write and cost usage while rejecting invalid quantities', () => {
    expect(
      parseUsage({
        cacheRead: 7,
        cacheWrite: 5,
        cost: { total: 0.0012 },
        input: 3,
        output: 4,
        totalTokens: 19,
      })
    ).toEqual({
      cacheReadTokens: 7,
      cacheWriteTokens: 5,
      completionTokens: 4,
      costEstimateUsd: 0.0012,
      inputTokens: 3,
      totalTokens: 19,
    });
    expect(
      parseUsage({
        cacheRead: Number.NaN,
        cacheWrite: -1,
        cost: { total: Number.POSITIVE_INFINITY },
        input: -1,
        output: Number.NEGATIVE_INFINITY,
        totalTokens: -1,
      })
    ).toEqual({
      completionTokens: 0,
      inputTokens: 0,
      totalTokens: 0,
    });
    expect(parseUsage({ input: 3, output: 4, totalTokens: 7 })).not.toHaveProperty(
      'costEstimateUsd'
    );
  });

  it('preserves provider-reported cache quantities in diagnostics', () => {
    const tracker = new GatewayUsageTracker({ now: () => new Date('2026-05-26T00:00:00.000Z') });

    tracker.recordUsage({
      endpoint: 'chat_completions',
      model: 'claude-sonnet-4-5',
      provider: providerConfig(),
      usage: {
        cacheRead: 60,
        cacheWrite: 20,
        input: 40,
        output: 5,
        totalTokens: 125,
      },
    });

    expect(tracker.snapshot().summaries[0]).toEqual({
      cacheReadTokens: 60,
      cacheWriteTokens: 20,
      completionTokens: 5,
      endpoint: 'chat_completions',
      inputTokens: 100,
      lastObservedAt: '2026-05-26T00:00:00.000Z',
      model: 'claude-sonnet-4-5',
      providerId: 'openai',
      requestCount: 1,
      totalTokens: 105,
    });
  });

  it('aggregates Chat-style cached token usage', () => {
    const tracker = new GatewayUsageTracker({ now: () => new Date('2026-05-26T00:00:00.000Z') });

    tracker.recordUsage({
      endpoint: 'chat_completions',
      model: 'gpt-5.1',
      provider: providerConfig(),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: {
          cached_tokens: 80,
        },
      },
    });

    expect(tracker.snapshot()).toEqual({
      summaries: [
        {
          cacheReadTokens: 80,
          completionTokens: 20,
          endpoint: 'chat_completions',
          inputTokens: 100,
          lastObservedAt: '2026-05-26T00:00:00.000Z',
          model: 'gpt-5.1',
          providerId: 'openai',
          requestCount: 1,
          totalTokens: 120,
        },
      ],
    });
  });

  it('aggregates Responses-style input token usage', () => {
    const tracker = new GatewayUsageTracker({ now: () => new Date('2026-05-26T00:00:00.000Z') });

    tracker.recordUsage({
      endpoint: 'responses',
      model: 'gpt-5.1',
      provider: providerConfig(),
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        input_tokens: 200,
        output_tokens: 30,
        total_tokens: 230,
      },
    });

    expect(tracker.snapshot().summaries[0]).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 30,
      endpoint: 'responses',
      inputTokens: 200,
      lastObservedAt: '2026-05-26T00:00:00.000Z',
      model: 'gpt-5.1',
      providerId: 'openai',
      requestCount: 1,
      totalTokens: 230,
    });
  });

  it('observes usage from terminal SSE chunks without modifying the stream', async () => {
    const tracker = new GatewayUsageTracker({ now: () => new Date('2026-05-26T00:00:00.000Z') });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"type":"response.output_text.delta","delta":"Hi"}',
              '',
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55}}}',
              '',
              'data: [DONE]',
              '',
            ].join('\n')
          )
        );
        controller.close();
      },
    });

    const observed = tracker.observeSseUsage(stream, {
      endpoint: 'responses',
      model: 'gpt-5.1',
      onUsage: (usage) => {
        expect(usage).toMatchObject({ input_tokens: 50, output_tokens: 5 });
      },
      provider: providerConfig(),
    });

    await expect(new Response(observed).text()).resolves.toContain('response.completed');
    expect(tracker.snapshot().summaries[0]).toEqual({
      completionTokens: 5,
      endpoint: 'responses',
      inputTokens: 50,
      lastObservedAt: '2026-05-26T00:00:00.000Z',
      model: 'gpt-5.1',
      providerId: 'openai',
      requestCount: 1,
      totalTokens: 55,
    });
  });

  it('cancels the upstream stream exactly once when the observed stream is cancelled', async () => {
    const cancel = vi.fn();
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"response.output_text.delta"}\n\n')
          );
        }
      },
    });
    const observed = new GatewayUsageTracker().observeSseUsage(stream, {
      endpoint: 'responses',
      model: 'gpt-5.1',
      provider: providerConfig(),
    });
    const reader = observed.getReader();

    await reader.read();
    await reader.cancel('consumer disconnected');

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('consumer disconnected');
  });
});
