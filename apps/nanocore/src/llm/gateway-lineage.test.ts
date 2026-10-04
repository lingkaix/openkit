import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { GatewayAttemptFailure } from './gateway-execution.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

const requestId = '12345678-1234-4234-8234-123456789abc';
/** Actual public routes, stock synthetic models and Workspace ledger; no ledger double. */
function fixture(missingKey = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'gateway-lineage-'));
  const store = createDemoStore({ dataRoot });
  const workspaceId = store.createWorkspace('Lineage').id;
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId });
  const primary = fauxProvider({ provider: 'openai', models: [{ id: 'gpt-5.1' }] });
  const backup = fauxProvider({ provider: 'anthropic', models: [{ id: 'claude-sonnet-4-5' }] });
  const models = createModels();
  models.setProvider(primary.provider);
  models.setProvider(backup.provider);
  const dispatcher = new LLMGatewayProviderDispatcher({
    piAiClient: new PiAiGatewayClient({ models }),
  });
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    llmGatewayDispatcher: dispatcher,
    openKitConfig: {},
    providerCredentialResolver: (ref) => (ref === 'test:backup' ? 'synthetic-backup-key' : null),
    providerRegistry: new ProviderRegistry([
      {
        id: 'p',
        displayName: 'Primary',
        vendor: 'openai',
        kind: missingKey ? 'direct' : 'local',
        models: ['gpt-5.1'],
        ...(missingKey
          ? {
              secretRef: 'vault://absent_key',
              modelMetadata: {
                'gpt-5.1': {
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['low'] }],
                },
              },
            }
          : {}),
      },
      {
        id: 'b',
        displayName: 'Backup',
        vendor: 'anthropic',
        kind: missingKey ? 'direct' : 'local',
        ...(missingKey
          ? {
              secretRef: 'test:backup',
              modelMetadata: {
                'claude-sonnet-4-5': {
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['high'] }],
                },
              },
            }
          : {}),
        models: ['claude-sonnet-4-5'],
      },
    ]),
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      logicalModels: [
        {
          id: 'tier',
          displayName: 'Tier',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: [
            { id: 'primary', providerProfileId: 'p', providerModel: 'gpt-5.1' },
            { id: 'backup', providerProfileId: 'b', providerModel: 'claude-sonnet-4-5' },
          ],
        },
      ],
    },
  });
  const post = (endpoint: string, stream = false, attributed = true) =>
    app.request(`/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tier',
        stream,
        ...(endpoint === 'responses'
          ? { input: 'Hello' }
          : { messages: [{ role: 'user', content: 'Hello' }] }),
        ...(attributed ? { metadata: { openkit: { workspaceId, requestId } } } : {}),
      }),
    });
  const read = () => {
    const db = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(db);
    try {
      return {
        calls: listWorkspaceCapabilityCalls(db, workspaceId),
        usage: listWorkspaceUsageRecords(db, workspaceId),
        rows: db.sqlite.prepare('SELECT * FROM capability_calls').all(),
      };
    } finally {
      db.sqlite.close();
    }
  };
  return {
    app,
    coreDb,
    store,
    workspaceId,
    dataRoot,
    dispatcher,
    primary,
    backup,
    post,
    read,
    close() {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('public durable logical Gateway lineage', () => {
  for (const endpoint of ['responses', 'chat/completions']) {
    for (const stream of [false, true]) {
      it(`${endpoint} stream=${stream}: one call releases the backup after primary rejection and carries deadline`, async () => {
        const f = fixture();
        const spy = vi.spyOn(
          f.dispatcher,
          endpoint === 'responses'
            ? stream
              ? 'createResponsesStream'
              : 'createResponses'
            : stream
              ? 'createChatCompletionStream'
              : 'createChatCompletion'
        );
        f.primary.setResponses([
          fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'invalid_api_key' }),
        ]);
        f.backup.setResponses([fauxAssistantMessage('backup served')]);
        try {
          const before = Date.now();
          const response = await f.post(endpoint, stream);
          const text = await response.text();
          expect(response.status, text).toBe(200);
          if (!stream) expect(text).toContain('backup served');
          else expect(text).toContain('backup');
          const { calls, rows } = f.read();
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({
            providerRef: null,
            status: 'succeeded',
            extensions: {
              'openkit.gateway/routeLineage': {
                logicalModelId: 'tier',
                entries: [
                  expect.objectContaining({
                    kind: 'attempt',
                    routeMemberId: 'primary',
                    failureKind: 'auth_rejected',
                    outputBegan: false,
                  }),
                  expect.objectContaining({
                    kind: 'attempt',
                    routeMemberId: 'backup',
                    outputBegan: true,
                    terminalResult: 'succeeded',
                  }),
                ],
              },
            },
          });
          expect(rows[0]).toHaveProperty('extensions_json');
          expect(f.primary.state.callCount).toBe(1);
          expect(f.backup.state.callCount).toBe(1);
          for (const call of spy.mock.calls)
            expect(call[2]?.transport?.deadline).toBeGreaterThanOrEqual(before + 120000);
          expect(spy.mock.calls[0]?.[2]?.transport?.deadline).toBe(
            spy.mock.calls[1]?.[2]?.transport?.deadline
          );
          const original = f.read();
          const reused = await f.post(endpoint, stream);
          expect(reused.status).toBe(400);
          expect(await reused.json()).toMatchObject({
            error: { code: 'gateway_provider_request_invalid' },
          });
          expect(f.primary.state.callCount).toBe(1);
          expect(f.backup.state.callCount).toBe(1);
          expect(f.read()).toEqual(original);
        } finally {
          f.close();
        }
      });
    }
  }
  it.each([
    { requestedEffort: 'medium', effectiveEffort: 'high' },
    { requestedEffort: 'medium', effectiveEffortReason: 'model_without_reasoning' },
  ])('audit.read projects route explanation without Provider identity, effort facts or raw extensions: %j', async (effortFacts) => {
    const f = fixture();
    f.primary.setResponses([fauxAssistantMessage('served')]);
    try {
      expect((await f.post('responses')).status).toBe(200);
      const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
      try {
        const row = db.sqlite.prepare('SELECT extensions_json FROM capability_calls').get() as {
          extensions_json: string;
        };
        const extensions = JSON.parse(row.extensions_json);
        Object.assign(extensions['openkit.gateway/routeLineage'].entries[0], effortFacts);
        db.sqlite.prepare('UPDATE capability_calls SET extensions_json = ?').run(
          JSON.stringify({
            ...extensions,
            'future.example/evidence': { label: 'canonical-only-marker' },
          })
        );
      } finally {
        db.sqlite.close();
      }
      expect(
        f.read().calls[0]?.extensions?.['openkit.gateway/routeLineage']?.entries[0]
      ).toMatchObject(effortFacts);
      const response = await f.app.request(
        ...operationRequest('usage.read', { workspaceId: f.workspaceId }, {})
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const projection = await response.json();
      expect(projection.capabilityCalls[0]?.routeLineage).toMatchObject({
        logicalModelId: 'tier',
        entries: [{ kind: 'attempt', routeMemberId: 'primary', released: true }],
      });
      expect(projection.capabilityCalls[0]).not.toHaveProperty('extensions');
      expect(JSON.stringify(projection)).not.toContain('future.example/evidence');
      expect(JSON.stringify(projection)).not.toContain('canonical-only-marker');
      const serialized = JSON.stringify(projection.capabilityCalls[0]?.routeLineage);
      for (const forbidden of [
        'providerProfileId',
        'providerModel',
        'accountSlotId',
        'usageRecordIds',
        'invalid_api_key',
        'requestedEffort',
        'effectiveEffort',
        'effectiveEffortReason',
      ])
        expect(serialized).not.toContain(forbidden);
    } finally {
      f.close();
    }
  });
  it('usage.read omits another user private Thread for a readonly member while preserving administrator eligibility', async () => {
    const f = fixture();
    const memberApp = createApp({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      mode: 'server',
    });
    const memberToken = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: [f.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const thread = f.store.createThread(f.workspaceId, 'Private', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_other',
    });
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      applyScopedMigrations(db);
      const call = startCapabilityCall({
        workspaceDb: db,
        workspaceId: f.workspaceId,
        threadId: thread.id,
        authorityActor: null,
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses',
        redactionClass: 'metadata-only',
      });
      recordUsage({
        workspaceDb: db,
        call,
        records: [{ category: 'llm', unit: 'tokens', quantity: 1, source: 'reported' }],
      });
      expect(f.read().calls).toHaveLength(1);
      const response = await memberApp.request(
        ...operationRequest(
          'usage.read',
          { workspaceId: f.workspaceId },
          { headers: { authorization: `Bearer ${memberToken.secret}` } }
        )
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ capabilityCalls: [], usageRecords: [] });
      const administratorResponse = await f.app.request(
        ...operationRequest('usage.read', { workspaceId: f.workspaceId }, {})
      );
      expect(administratorResponse.status).toBe(200);
      const administratorProjection = await administratorResponse.json();
      expect(administratorProjection.capabilityCalls).toHaveLength(1);
      expect(administratorProjection.usageRecords).toHaveLength(1);
    } finally {
      db.sqlite.close();
      f.close();
    }
  });
  it('same-member retry keeps one call and deduplicates identical usage references', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.primary.setResponses([
      Object.assign(
        fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'rate_limit_exceeded' }),
        { code: 'rate_limit_exceeded' }
      ),
      fauxAssistantMessage('retry served'),
    ]);
    try {
      const pending = f.post('responses');
      await vi.runAllTimersAsync();
      expect((await pending).status).toBe(200);
      const { calls } = f.read();
      expect(calls).toHaveLength(1);
      const entries = calls[0]?.extensions?.['openkit.gateway/routeLineage']?.entries;
      expect(entries).toMatchObject([
        { kind: 'attempt', retryIndex: 0, failureKind: 'rate_limited' },
        { kind: 'attempt', retryIndex: 1, terminalResult: 'succeeded' },
      ]);
      expect(f.backup.state.callCount).toBe(0);
    } finally {
      vi.useRealTimers();
      f.close();
    }
  });
  it('refuses a reused running request before any Provider invocation and preserves its bytes', async () => {
    const f = fixture();
    f.primary.setResponses([fauxAssistantMessage('must not run')]);
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      applyScopedMigrations(db);
      startCapabilityCall({
        workspaceDb: db,
        workspaceId: f.workspaceId,
        authorityActor: { kind: 'user', id: 'user_local' },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses',
        providerRef: 'p',
        serviceRef: 'llm-gateway',
        redactionClass: 'metadata-only',
        requestId,
      });
      const before = db.sqlite.prepare('SELECT * FROM capability_calls').all();
      const response = await f.post('responses');
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'gateway_provider_request_invalid' },
      });
      expect(f.primary.state.callCount).toBe(0);
      expect(f.backup.state.callCount).toBe(0);
      expect(db.sqlite.prepare('SELECT * FROM capability_calls').all()).toEqual(before);
    } finally {
      db.sqlite.close();
      f.close();
    }
  });
  it('identical backend usage collapses to one measurement cited by both retry entries', async () => {
    const f = fixture();
    vi.useFakeTimers();
    const dispatch = vi
      .spyOn(f.dispatcher, 'createResponses')
      .mockImplementation(async (_provider, request, context) => {
        context?.onUsage?.({ total_tokens: 42 });
        if (dispatch.mock.calls.length === 1)
          throw new GatewayAttemptFailure({ kind: 'rate_limited', settled: true });
        return {
          id: 'resp_usage',
          object: 'response',
          status: 'completed',
          model: request.model,
          output: [],
          usage: { total_tokens: 42 },
        };
      });
    try {
      const pending = f.post('responses');
      await vi.runAllTimersAsync();
      expect((await pending).status).toBe(200);
      const { calls, usage } = f.read();
      expect(calls).toHaveLength(1);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ quantity: 42, providerRef: 'p', modelId: 'tier' });
      const entries = calls[0]?.extensions?.['openkit.gateway/routeLineage']?.entries;
      expect(entries).toHaveLength(2);
      expect(
        entries?.map((entry) => (entry.kind === 'attempt' ? entry.usageRecordIds : []))
      ).toEqual([[usage[0]?.id], [usage[0]?.id]]);
      expect(dispatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      f.close();
    }
  });
  it('a released stream without terminal evidence fails without replay and retains unknown lineage', async () => {
    const f = fixture();
    vi.spyOn(f.dispatcher, 'createResponsesStream').mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"released"}\n\n'
            )
          );
          controller.close();
        },
      })
    );
    try {
      const response = await f.post('responses', true);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('response.failed');
      expect(f.read().calls[0]).toMatchObject({
        status: 'failed',
        errorCode: 'provider_stream_truncated',
        extensions: {
          'openkit.gateway/routeLineage': {
            entries: [{ terminalResult: 'unknown', outputBegan: true }],
          },
        },
      });
      expect(f.backup.state.callCount).toBe(0);
    } finally {
      f.close();
    }
  });
  it('unattributed public calls keep no durable row', async () => {
    const f = fixture();
    f.primary.setResponses([fauxAssistantMessage('blind')]);
    try {
      expect((await f.post('responses', false, false)).status).toBe(200);
      expect(f.read().calls).toEqual([]);
    } finally {
      f.close();
    }
  });
});

describe('slice 1d round 2 terminal frame closeout', () => {
  for (const failed of [true, false])
    it(`public released ${failed ? 'failed' : 'incomplete'} frame keeps its logical outcome`, async () => {
      const f = fixture();
      const frames = [
        { type: 'response.output_text.delta', delta: 'released' },
        {
          type: failed ? 'response.failed' : 'response.incomplete',
          response: {
            status: failed ? 'failed' : 'incomplete',
            ...(failed
              ? { error: { code: 'gateway_provider_unavailable' } }
              : { incomplete_details: { reason: 'max_output_tokens' } }),
          },
        },
      ];
      let index = 0;
      const dispatch = vi.spyOn(f.dispatcher, 'createResponsesStream').mockResolvedValue(
        new ReadableStream({
          pull(controller) {
            if (index < frames.length)
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(frames[index++])}\n\n`)
              );
            else controller.close();
          },
        })
      );
      try {
        const response = await f.post('responses', true);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(failed ? 'response.failed' : 'response.incomplete');
        expect(f.read().calls[0]).toMatchObject({
          status: failed ? 'failed' : 'succeeded',
          errorCode: failed ? 'gateway_provider_unavailable' : null,
          extensions: {
            'openkit.gateway/routeLineage': {
              entries: [{ outputBegan: true, terminalResult: failed ? 'failed' : 'incomplete' }],
            },
          },
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(f.backup.state.callCount).toBe(0);
      } finally {
        f.close();
      }
    });
});

it('skips a missing API key with auth_rejected lineage and only backup effort levels', async () => {
  const f = fixture(true);
  f.backup.setResponses([fauxAssistantMessage('backup served')]);
  try {
    const diagnostics = await (await f.app.request('/api/app/diagnostics')).json();
    expect(diagnostics.gateway.models[0].reasoningEffortLevels).toEqual(['high']);
    const response = await f.post('responses');
    expect(response.status, await response.text()).toBe(200);
    expect(f.primary.state.callCount).toBe(0);
    expect(f.backup.state.callCount).toBe(1);
    const { calls, usage } = f.read();
    expect(calls).toHaveLength(1);
    const measured = usage.filter((record) => record.capabilityCallId === calls[0]?.id);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((record) => record.providerRef === 'b')).toBe(true);
    expect(calls[0]?.extensions?.['openkit.gateway/routeLineage']).toMatchObject({
      entries: [
        {
          kind: 'unavailable',
          routeMemberId: 'primary',
          failureKind: 'auth_rejected',
          unavailableReason: 'provider_api_key_missing',
        },
        { kind: 'attempt', routeMemberId: 'backup', terminalResult: 'succeeded' },
      ],
    });
  } finally {
    f.close();
  }
});
