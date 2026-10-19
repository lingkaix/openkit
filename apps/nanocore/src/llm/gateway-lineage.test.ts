import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import {
  listServerCapabilityCalls,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { listServerPermissionDecisions } from '../policy/permission-decisions.js';
import { type ProviderCredentialResolver, ProviderRegistry } from '../providers/registry.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { GatewayAttemptFailure } from './gateway-execution.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

const requestId = '12345678-1234-4234-8234-123456789abc';
/** Actual public routes, stock synthetic models and Workspace ledger; no ledger double. */
function fixture(missingKey = false, enabled = true) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'gateway-lineage-'));
  const store = createDemoStore({ dataRoot });
  const workspaceId = store.createWorkspace('Lineage').id;
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId,
  });
  const primary = fauxProvider({ provider: 'openai', models: [{ id: 'gpt-5.1' }] });
  const backup = fauxProvider({ provider: 'anthropic', models: [{ id: 'claude-sonnet-4-5' }] });
  const models = createModels();
  models.setProvider(primary.provider);
  models.setProvider(backup.provider);
  const dispatcher = new LLMGatewayProviderDispatcher({
    piAiClient: new PiAiGatewayClient({ models }),
  });
  const credentialResolver = vi.fn<ProviderCredentialResolver>((ref) =>
    ref === 'test:backup' ? 'synthetic-backup-key' : null
  );
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    llmGatewayDispatcher: dispatcher,
    openKitConfig: {},
    providerCredentialResolver: credentialResolver,
    providerRegistry: new ProviderRegistry([
      {
        id: 'p',
        displayName: 'Primary',
        vendor: 'openai',
        kind: missingKey ? 'direct' : 'local',
        models: ['gpt-5.1'],
        ...(missingKey
          ? {
              secretRef: 'vault://vault_00000000-0000-78f9-b548-bb61f3474278',
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
      enabled,
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
    credentialResolver,
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

describe('public Gateway decision Audit call linkage', () => {
  for (const endpoint of ['responses', 'chat/completions']) {
    for (const attributed of [true, false]) {
      it(`${endpoint} ${attributed ? 'Workspace' : 'Server'} decision links the exact assigned call`, async () => {
        const f = fixture();
        f.primary.setResponses([fauxAssistantMessage('served')]);
        try {
          const response = await f.post(endpoint, false, attributed);
          expect(response.status, await response.text()).toBe(200);
          const calls = attributed ? f.read().calls : listServerCapabilityCalls(f.coreDb);
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({ status: 'succeeded' });
          const decisions = listServerPermissionDecisions(f.coreDb);
          expect(decisions).toHaveLength(1);
          const decision = decisions[0];
          expect(decision).toMatchObject({
            action: `llm.gateway.${endpoint === 'responses' ? 'responses' : 'chat_completions'}`,
            result: 'allow',
            reasonCode: 'gateway_allowed',
            enforcementPoint: 'llm.gateway.policy',
          });
          const audits = listServerAuditEvents(f.coreDb).filter(
            (event) => event.permissionDecisionId === decision?.decisionId
          );
          expect(audits).toHaveLength(1);
          expect(audits[0]).toMatchObject({
            id: decision?.auditEventId,
            action: 'permission.decision',
            capabilityCallId: calls[0]?.id,
            permissionDecisionId: decision?.decisionId,
          });
          expect(decision?.contextSummary).toMatchObject({ capabilityCallId: calls[0]?.id });
          expect(f.primary.state.callCount).toBe(1);
          expect(f.backup.state.callCount).toBe(0);
        } finally {
          f.close();
        }
      });

      it(`${endpoint} ${attributed ? 'Workspace' : 'Server'} Audit write failure blocks credentials and Provider effects and settles opened calls`, async () => {
        const f = fixture(true);
        f.backup.setResponses([fauxAssistantMessage('must not run')]);
        try {
          // Fail only the required allowed-decision Audit crossing, leaving call closeout writable.
          f.coreDb.sqlite.exec(`
            CREATE TRIGGER fail_gateway_decision_audit
            BEFORE INSERT ON audit_events
            WHEN NEW.action = 'permission.decision' AND EXISTS (
              SELECT 1 FROM permission_decisions
              WHERE decision_id = NEW.permission_decision_id
                AND enforcement_point = 'llm.gateway.policy' AND result = 'allow'
            )
            BEGIN
              SELECT RAISE(ABORT, 'synthetic required Gateway Audit write failure');
            END;
          `);
          const response = await f.post(endpoint, false, attributed);
          await response.text();
          expect.soft(response.status).toBeGreaterThanOrEqual(400);
          // Existing model readiness may inspect presence without a governed call context.
          expect.soft(f.credentialResolver.mock.calls.filter(([, context]) => context)).toEqual([]);
          expect.soft(f.primary.state.callCount).toBe(0);
          expect.soft(f.backup.state.callCount).toBe(0);
          const calls = attributed ? f.read().calls : listServerCapabilityCalls(f.coreDb);
          expect(calls.length).toBeLessThanOrEqual(1);
          for (const call of calls) expect.soft(call.status).toBe('failed');
          expect(listServerPermissionDecisions(f.coreDb)).toEqual([]);
          expect(
            listServerAuditEvents(f.coreDb).filter(
              (event) => event.action === 'permission.decision'
            )
          ).toEqual([]);
        } finally {
          f.close();
        }
      });
    }

    it(`${endpoint} disabled policy denies without a call link or Provider effects`, async () => {
      const f = fixture(true, false);
      try {
        const response = await f.post(endpoint);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'gateway_disabled' } });
        const decisions = listServerPermissionDecisions(f.coreDb);
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({ result: 'deny', reasonCode: 'gateway_disabled' });
        expect(decisions[0]?.contextSummary).not.toHaveProperty('capabilityCallId');
        const audits = listServerAuditEvents(f.coreDb).filter(
          (event) => event.permissionDecisionId === decisions[0]?.decisionId
        );
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          id: decisions[0]?.auditEventId,
          capabilityCallId: null,
        });
        expect(f.read().calls).toEqual([]);
        expect(listServerCapabilityCalls(f.coreDb)).toEqual([]);
        expect(f.credentialResolver).not.toHaveBeenCalled();
        expect(f.primary.state.callCount).toBe(0);
        expect(f.backup.state.callCount).toBe(0);
      } finally {
        f.close();
      }
    });

    it(`${endpoint} denied Workspace access creates no call or false Audit join`, async () => {
      const f = fixture(true);
      try {
        const response = await f.app.request(`/v1/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'tier',
            ...(endpoint === 'responses'
              ? { input: 'Hello' }
              : { messages: [{ role: 'user', content: 'Hello' }] }),
            metadata: { openkit: { workspaceId: 'ws_00000000-0000-7000-8000-000000000099' } },
          }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
        expect(f.read().calls).toEqual([]);
        expect(listServerCapabilityCalls(f.coreDb)).toEqual([]);
        for (const event of listServerAuditEvents(f.coreDb))
          expect(event.capabilityCallId).toBeNull();
        for (const decision of listServerPermissionDecisions(f.coreDb))
          expect(decision.contextSummary).not.toHaveProperty('capabilityCallId');
        expect(f.credentialResolver).not.toHaveBeenCalled();
        expect(f.primary.state.callCount).toBe(0);
        expect(f.backup.state.callCount).toBe(0);
      } finally {
        f.close();
      }
    });

    it(`${endpoint} reused request creates no new call and cannot link a new decision to the earlier call`, async () => {
      const f = fixture();
      f.primary.setResponses([fauxAssistantMessage('served')]);
      try {
        expect((await f.post(endpoint)).status).toBe(200);
        const before = f.read();
        const priorDecisionIds = new Set(
          listServerPermissionDecisions(f.coreDb).map((decision) => decision.decisionId)
        );
        const priorAuditIds = new Set(listServerAuditEvents(f.coreDb).map((event) => event.id));
        const response = await f.post(endpoint);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: 'gateway_provider_request_invalid' },
        });
        expect(f.read()).toEqual(before);
        for (const event of listServerAuditEvents(f.coreDb))
          if (!priorAuditIds.has(event.id)) expect(event.capabilityCallId).toBeNull();
        for (const decision of listServerPermissionDecisions(f.coreDb))
          if (!priorDecisionIds.has(decision.decisionId))
            expect(decision.contextSummary).not.toHaveProperty('capabilityCallId');
        expect(f.primary.state.callCount).toBe(1);
        expect(f.backup.state.callCount).toBe(0);
        expect(f.credentialResolver).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    });
  }
});

describe('public durable logical Gateway lineage', () => {
  it('retains a public call without Workspace metadata in the Server ledger and keeps Core open', async () => {
    const f = fixture(true);
    try {
      f.primary.setResponses([
        fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'invalid_api_key' }),
      ]);
      const served = fauxAssistantMessage('server served');
      served.usage = { ...served.usage, input: 7, output: 3, totalTokens: 10 };
      f.backup.setResponses([served]);
      const response = await f.app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tier', messages: [{ role: 'user', content: 'hello' }] }),
      });
      expect(response.status, await response.text()).toBe(200);
      const call = f.coreDb.sqlite
        .prepare('SELECT call_id, workspace_id, status FROM capability_calls')
        .get() as { call_id: string };
      expect(call).toMatchObject({ workspace_id: null, status: 'succeeded' });
      const audits = f.coreDb.sqlite
        .prepare(
          'SELECT action, actor_json, authentication_json FROM audit_events WHERE capability_call_id = ? ORDER BY created_at'
        )
        .all(call.call_id);
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'capability.admit',
          authentication_json: JSON.stringify({ credentialKind: 'local', credentialId: null }),
          actor_json: JSON.stringify({
            kind: 'user',
            id: 'usr_00000000-0000-7000-8000-000000000001',
          }),
        }),
        expect.objectContaining({
          action: 'capability.finish',
          authentication_json: JSON.stringify({ credentialKind: 'local', credentialId: null }),
          actor_json: JSON.stringify({
            kind: 'user',
            id: 'usr_00000000-0000-7000-8000-000000000001',
          }),
        }),
      ]);
      expect(f.credentialResolver).toHaveBeenCalledWith(
        'test:backup',
        expect.objectContaining({
          actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          capabilityCallId: call.call_id,
        })
      );
      expect(
        f.coreDb.sqlite
          .prepare(
            "SELECT sum(quantity) AS quantity FROM usage_records WHERE capability_call_id = ? AND unit = 'tokens'"
          )
          .get(call.call_id)
      ).toEqual({ quantity: 10 });
      expect(f.coreDb.sqlite.open).toBe(true);
    } finally {
      f.close();
    }
  });

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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace-readonly',
      workspaceIds: [f.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const thread = f.store.createThread(f.workspaceId, 'Private', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
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
        authorityActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
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
  it('public calls without Workspace metadata keep Workspace history empty', async () => {
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
    const diagnostics = await (
      await f.app.request(...operationRequest('diagnostics.app', {}))
    ).json();
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
