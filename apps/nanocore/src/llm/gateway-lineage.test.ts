import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { AuthVariables } from '../auth/middleware.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  listServerCapabilityCalls,
  listServerUsageRecords,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { listServerPermissionDecisions } from '../policy/permission-decisions.js';
import { resolveProviderProfileToLLMConfig } from '../providers/llm-config.js';
import { type ProviderCredentialResolver, ProviderRegistry } from '../providers/registry.js';
import type { ControlStoreProductReadHandle } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import type { ServerWorkCommandBinding } from '../storage/server-work-command.js';
import type { ServerWorkIntent, ServerWorkReceipt } from '../storage/server-work-port.js';
import { storageReceipt } from '../storage/storage-owner.js';
import { type CreateAppOptions, createApp } from '../test-support/app.js';
import {
  heldServerPermissionAck,
  releaseCommit,
} from '../test-support/control-native-transport.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { openTestServerWork } from '../test-support/server-work-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { GatewayAttemptFailure } from './gateway-execution.js';
import { registerLlmGatewayRoutes } from './gateway-routes.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

// Keep the actual native owner; hold only this family's exact acknowledged reply on Main.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

const requestId = '12345678-1234-4234-8234-123456789abc';
/** Actual public routes, stock synthetic models and Workspace ledger; no ledger double. */
async function fixture(missingKey = false, enabled = true, managedConfiguration = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'gateway-lineage-'));
  const store = await createDemoStore({ dataRoot });
  const workspaceId = (await store.createWorkspace('Lineage')).id;
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
  const options: CreateAppOptions = {
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
  };
  if (managedConfiguration) {
    const providersDir = join(dataRoot, 'config', 'providers');
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(join(dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(join(dataRoot, 'config/gateway.jsonc'), JSON.stringify(options.gatewayConfig));
    for (const profile of options.providerRegistry!.list()) {
      writeFileSync(
        join(providersDir, `${profile.id}.provider.jsonc`),
        JSON.stringify({ schemaVersion: 1, ...profile })
      );
    }
  }
  const manager = managedConfiguration
    ? createRuntimeConfigManager({
        dataRoot,
        captureCoverage: store,
      })
    : undefined;
  const files = manager
    ? new RuntimeConfigFileService({
        dataRoot,
        userId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceIds: [workspaceId],
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: () => manager.status(),
      })
    : undefined;
  const currentAppOptions = { ...options, ...(manager ? { runtimeConfigManager: manager } : {}) };
  const app = createApp(currentAppOptions);
  let serverWorkApp: typeof app | undefined;
  const post = (endpoint: string, stream = false, attributed = true) =>
    (attributed ? app : (serverWorkApp ?? app)).request(`/v1/${endpoint}`, {
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
  let serverWorkReader: ControlStoreProductReadHandle | undefined;
  const admitServerLedger = async () => {
    const owner = await openTestServerWork(coreDb, {
      gatewayConfig: options.gatewayConfig!,
      providerRegistry: options.providerRegistry!,
    });
    serverWorkReader = owner.reader;
    // Faux providers have no HTTP serializer. Exercise the real Server contact claim at their boundary.
    const chat = dispatcher.createChatCompletion.bind(dispatcher);
    vi.spyOn(dispatcher, 'createChatCompletion').mockImplementation(
      async (provider, request, context) => {
        const admit = context?.transport?.finalRequestAdmission;
        if (!admit) throw new Error('Server contact requires final transport admission.');
        await admit({ payload: request, contextWindowTokens: 16_000, outputReserveTokens: 1_000 });
        return chat(provider, request, context);
      }
    );
    const responses = dispatcher.createResponses.bind(dispatcher);
    vi.spyOn(dispatcher, 'createResponses').mockImplementation(
      async (provider, request, context) => {
        const admit = context?.transport?.finalRequestAdmission;
        if (!admit) throw new Error('Server contact requires final transport admission.');
        await admit({ payload: request, contextWindowTokens: 16_000, outputReserveTokens: 1_000 });
        return responses(provider, request, context);
      }
    );
    serverWorkApp = createApp({ ...currentAppOptions, store: owner.store });
    return serverWorkApp;
  };
  return {
    app,
    coreDb,
    store,
    workspaceId,
    dataRoot,
    dispatcher,
    serverApp: () => createApp({ ...options, mode: 'server' }),
    manager,
    files,
    credentialResolver,
    primary,
    backup,
    post,
    read,
    admitServerLedger,
    readServerCalls: () => listServerCapabilityCalls(coreDb, serverWorkReader),
    readServerUsage: () => listServerUsageRecords(coreDb, serverWorkReader),
    async close() {
      serverWorkReader?.close();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

it('retains the Server Gateway producer through stream settlement and recovery of a lost owner ACK', async () => {
  const f = await fixture(false, true, true);
  const requestOwner = new AsyncLocalStorage<{ active: boolean }>();
  const terminalStarted = Promise.withResolvers<void>();
  const releaseTerminal = Promise.withResolvers<void>();
  const producerFinished = Promise.withResolvers<void>();
  const intents = new Map<string, ServerWorkIntent>();
  const receipts = new Map<string, ServerWorkReceipt>();
  const calls: string[] = [];
  const ready = <Value>(value: Value) => ({ state: 'ready' as const, value });
  const producer = { active: false };
  const owned = (action: string) => {
    expect(requestOwner.getStore()).toBe(producer);
    expect(producer.active).toBe(true);
    calls.push(action);
  };
  const binding: ServerWorkCommandBinding = {
    deploymentId: 'server-producer-test',
    withProducer: async (effect) => {
      expect(producer.active).toBe(false);
      producer.active = true;
      try {
        return await requestOwner.run(producer, effect);
      } finally {
        producer.active = false;
        producerFinished.resolve();
      }
    },
    owner: {
      status: () => ({ state: 'ready', owner: 'server-work' }),
      stage: async (intent) => {
        owned(`stage:${intent.verb}`);
        intents.set(intent.requestId, intent);
        return ready(intent);
      },
      readIntent: async (requestId) => ready(intents.get(requestId) ?? null),
      readLocalReceipt: async (requestId) => ready(receipts.get(requestId) ?? null),
      settle: async (receipt) => {
        owned(`settle:${receipt.intent.verb}`);
        if (receipt.intent.verb === 'settle-call') {
          terminalStarted.resolve();
          await releaseTerminal.promise;
        }
        receipts.set(receipt.intent.requestId, receipt);
        if (receipt.intent.verb === 'settle-call') throw new Error('Committed owner ACK lost.');
        return ready(undefined);
      },
      isPublished: async (receipt) => {
        owned(`published:${receipt.intent.verb}`);
        return ready(receipts.get(receipt.intent.requestId) === receipt);
      },
      claimCallContact: async () => {
        owned('contact');
        return ready({ state: 'claimed-now' });
      },
      readUsageIds: async () => ready([]),
      writeRouteLineage: async (_receipt, { entryIndex }) => {
        owned('route');
        return ready(entryIndex ?? 0);
      },
    },
    kernel: {
      status: () => ({ state: 'ready', owner: 'control-kernel' }),
      decideServerWork: async (intent) => {
        owned(`decide:${intent.verb}`);
        expect(intents.get(intent.requestId)).toEqual(intent);
        return ready({
          state: 'settled',
          receipt: storageReceipt(intent, {
            disposition: 'applied',
            result: { decisionRef: intent.requestId },
          }),
        });
      },
      inspectServerWork: async () => ready({ state: 'absent' }),
    },
    callBudgetRef: () => null,
    verifyCallAuthority: () => true,
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('actor', {
      kind: 'local',
      userId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    await next();
  });
  registerLlmGatewayRoutes({
    app,
    coreDb: f.coreDb,
    serverWork: binding,
    llmGatewayDispatcher: f.dispatcher,
    resolveGatewayProvider: (providerId, model, _context, registry) =>
      resolveProviderProfileToLLMConfig(registry.get(providerId)!, undefined, model),
    runtimeConfig: () => f.manager!.current(),
  });
  f.primary.setResponses([fauxAssistantMessage('served')]);
  // The synthetic in-memory provider has no HTTP serializer. Invoke the declared
  // final transport admission before forwarding to its reversible stream.
  const syntheticStream = f.dispatcher.createChatCompletionStream.bind(f.dispatcher);
  vi.spyOn(f.dispatcher, 'createChatCompletionStream').mockImplementation(
    async (provider, request, dispatchContext) => {
      const admit = dispatchContext?.transport?.finalRequestAdmission;
      if (!admit) throw new Error('Server contact requires final transport admission.');
      await admit({ payload: request, contextWindowTokens: 16_000, outputReserveTokens: 1_000 });
      return syntheticStream(provider, request, dispatchContext);
    }
  );
  try {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tier',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(response.status).toBe(200);
    expect(producer.active).toBe(true);
    const text = response.text();
    await Promise.race([
      terminalStarted.promise,
      text.then(() => {
        throw new Error('The stream completed before its native finish began.');
      }),
    ]);
    expect(producer.active).toBe(true);
    expect(calls.filter((call) => call === 'contact')).toHaveLength(1);
    releaseTerminal.resolve();
    expect(await text).toContain('served');
    await producerFinished.promise;
    expect(producer.active).toBe(false);
    expect(calls).toContain('settle:settle-usage');
    expect(calls).toContain('published:settle-call');
    expect(f.primary.state.callCount).toBe(1);
  } finally {
    releaseTerminal.resolve();
    await f.close();
  }
}, 60_000);

it('keeps private decision transport out of authenticated public discovery and endpoint registration', async () => {
  const f = await fixture();
  try {
    const app = f.serverApp();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const headers = { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' };
    const discovery = await app.request('/v1/models', { headers });
    expect(discovery.status).toBe(200);
    const models = await discovery.json();
    expect(models.data.map((model: { id: string }) => model.id)).toContain('tier');
    expect(JSON.stringify(models)).not.toContain('"decisions"');
    expect(JSON.stringify(models)).not.toContain('"llm.decision"');
    expect(app.routes.some((route) => route.path === '/v1/decisions')).toBe(false);
    const response = await app.request('/v1/decisions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'tier', input: 'not a public category' }),
    });
    expect(response.status).toBe(404);
    expect(f.primary.state.callCount).toBe(0);
    expect(f.backup.state.callCount).toBe(0);
  } finally {
    await f.close();
  }
});

describe('public Gateway decision Audit call linkage', () => {
  for (const endpoint of ['responses', 'chat/completions']) {
    it(`${endpoint} waits for real Core Policy ACK and rechecks current authority or configuration before credentials or Provider contact`, async () => {
      const f = await fixture(true, true, endpoint === 'responses');
      let pending: Promise<Response> | undefined;
      try {
        const action =
          endpoint === 'responses' ? 'llm.gateway.responses' : 'llm.gateway.chat_completions';
        const held = await heldServerPermissionAck(
          { kind: 'gateway', action },
          () => (pending = f.post(endpoint))
        );
        expect(f.credentialResolver.mock.calls.filter(([, context]) => context)).toEqual([]);
        expect(f.primary.state.callCount).toBe(0);
        expect(f.backup.state.callCount).toBe(0);
        const evidence = listServerPermissionDecisions(f.coreDb);
        expect(evidence).toHaveLength(1);
        expect(evidence[0]).toMatchObject({ action, result: 'allow' });
        if (endpoint === 'responses') {
          const current = f.files!.readFile('gateway.jsonc');
          await f.files!.updateFile({
            id: 'gateway.jsonc',
            kind: 'gateway',
            expectedRevision: current.file.revision!,
            content: JSON.stringify({ schemaVersion: 1, enabled: false, logicalModels: [] }),
          });
          expect((await f.manager!.reload({ mode: 'safe', dryRun: false })).status).toBe('applied');
          expect(f.manager!.current().gatewayConfig.enabled).toBe(false);
        } else {
          f.coreDb.sqlite.transaction(() =>
            disableCanonicalUser(f.coreDb, 'usr_00000000-0000-7000-8000-000000000001')
          )();
        }
        releaseCommit();
        const response = await held.result;
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'workspace_access_denied' } });
        expect(f.credentialResolver.mock.calls.filter(([, context]) => context)).toEqual([]);
        expect(f.primary.state.callCount).toBe(0);
        expect(f.backup.state.callCount).toBe(0);
        expect(listServerPermissionDecisions(f.coreDb)).toEqual(evidence);
      } finally {
        releaseCommit();
        if (pending) await Promise.allSettled([pending]);
        await f.close();
      }
    });

    it(`${endpoint} holds Server inference before Policy admission and Provider contact`, async () => {
      const f = await fixture();
      try {
        const response = await f.post(endpoint, false, false);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { code: 'operation_storage_unavailable' },
        });
        expect(f.read().calls).toEqual([]);
        expect(listServerPermissionDecisions(f.coreDb)).toEqual([]);
        expect(f.credentialResolver).not.toHaveBeenCalled();
        expect(f.primary.state.callCount).toBe(0);
        expect(f.backup.state.callCount).toBe(0);
      } finally {
        await f.close();
      }
    });

    for (const attributed of [true, false]) {
      it(`${endpoint} ${attributed ? 'Workspace' : 'Server'} decision links the exact assigned call`, async () => {
        const f = await fixture();
        f.primary.setResponses([fauxAssistantMessage('served')]);
        try {
          if (!attributed) await f.admitServerLedger();
          const response = await f.post(endpoint, false, attributed);
          expect(response.status, await response.text()).toBe(200);
          const calls = attributed ? f.read().calls : f.readServerCalls();
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
          await f.close();
        }
      });

      it(`${endpoint} ${attributed ? 'Workspace' : 'Server'} Audit write failure blocks credentials and Provider effects and settles opened calls`, async () => {
        const f = await fixture(true);
        f.backup.setResponses([fauxAssistantMessage('must not run')]);
        try {
          if (!attributed) await f.admitServerLedger();
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
          const calls = attributed ? f.read().calls : f.readServerCalls();
          expect(calls.length).toBeLessThanOrEqual(1);
          for (const call of calls) expect.soft(call.status).toBe('failed');
          expect(listServerPermissionDecisions(f.coreDb)).toEqual([]);
          expect(
            listServerAuditEvents(f.coreDb).filter(
              (event) => event.action === 'permission.decision'
            )
          ).toEqual([]);
        } finally {
          await f.close();
        }
      });
    }

    it(`${endpoint} disabled policy denies without a call link or Provider effects`, async () => {
      const f = await fixture(true, false);
      try {
        await f.admitServerLedger();
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
        expect(f.readServerCalls()).toEqual([]);
        expect(f.credentialResolver).not.toHaveBeenCalled();
        expect(f.primary.state.callCount).toBe(0);
        expect(f.backup.state.callCount).toBe(0);
      } finally {
        await f.close();
      }
    });

    it(`${endpoint} denied Workspace access creates no call or false Audit join`, async () => {
      const f = await fixture(true);
      try {
        await f.admitServerLedger();
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
        expect(f.readServerCalls()).toEqual([]);
        for (const event of listServerAuditEvents(f.coreDb))
          expect(event.capabilityCallId).toBeNull();
        for (const decision of listServerPermissionDecisions(f.coreDb))
          expect(decision.contextSummary).not.toHaveProperty('capabilityCallId');
        expect(f.credentialResolver).not.toHaveBeenCalled();
        expect(f.primary.state.callCount).toBe(0);
        expect(f.backup.state.callCount).toBe(0);
      } finally {
        await f.close();
      }
    });

    it(`${endpoint} reused request creates no new call and cannot link a new decision to the earlier call`, async () => {
      const f = await fixture();
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
        await f.close();
      }
    });
  }
});

/**
 * Steps faked gateway backoff one second at a time.
 * Synchronous advances avoid waiting on the next delay. setImmediate still delivers native replies.
 * The lone 120s deadline timer is left in place so the pre-commit budget does not expire.
 */
async function settleFakedBackoff<T>(pending: Promise<T>): Promise<T> {
  const outcome = pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  let settled = false;
  void outcome.finally(() => {
    settled = true;
  });
  let advanced = 0;
  let maxTimers = 0;
  const wallDeadline = performance.now() + 8_000;
  while (!settled && performance.now() < wallDeadline && advanced < 20) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (settled) break;
    maxTimers = Math.max(maxTimers, vi.getTimerCount());
    if (vi.getTimerCount() < 2) continue;
    vi.advanceTimersByTime(1_000);
    advanced += 1;
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  if (!settled)
    throw new Error(
      `Gateway backoff did not settle under fake timers. timers=${vi.getTimerCount()} max=${maxTimers} advanced=${advanced}`
    );
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

describe('public durable logical Gateway lineage', () => {
  it('retains a public call without Workspace metadata in the Server ledger and keeps Core open', async () => {
    const f = await fixture(true);
    try {
      const app = await f.admitServerLedger();
      f.primary.setResponses([
        fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'invalid_api_key' }),
      ]);
      const served = fauxAssistantMessage('server served');
      served.usage = { ...served.usage, input: 7, output: 3, totalTokens: 10 };
      f.backup.setResponses([served]);
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tier', messages: [{ role: 'user', content: 'hello' }] }),
      });
      expect(response.status, await response.text()).toBe(200);
      expect(f.readServerCalls()).toEqual([
        expect.objectContaining({ owner: { kind: 'server' }, status: 'succeeded' }),
      ]);
      const [call] = f.readServerCalls();
      const audits = listServerAuditEvents(f.coreDb).filter(
        (event) => event.capabilityCallId === call!.id || event.resource === `call:${call!.id}`
      );
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'server-work.admit-call',
            actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
            resource: `call:${call!.id}`,
          }),
          expect.objectContaining({
            action: 'permission.decision',
            capabilityCallId: call!.id,
          }),
          expect.objectContaining({
            action: 'server-work.settle-call',
            actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
            resource: `call:${call!.id}`,
          }),
        ])
      );
      expect(f.credentialResolver).toHaveBeenCalledWith(
        'test:backup',
        expect.objectContaining({
          actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          capabilityCallId: call!.id,
        })
      );
      const usage = f.readServerUsage().filter((record) => record.capabilityCallId === call!.id);
      expect(
        usage
          .filter((record) => record.unit === 'tokens')
          .reduce((sum, record) => sum + record.quantity, 0)
      ).toBe(10);
      expect(f.read().calls).toEqual([]);
      expect(f.primary.state.callCount).toBe(0);
      expect(f.backup.state.callCount).toBe(1);
      expect(f.coreDb.sqlite.open).toBe(true);
    } finally {
      await f.close();
    }
  });

  for (const endpoint of ['responses', 'chat/completions']) {
    for (const stream of [false, true]) {
      it(`${endpoint} stream=${stream}: one call releases the backup after primary rejection and carries deadline`, async () => {
        const f = await fixture();
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
          await f.close();
        }
      });
    }
  }
  it.each([
    { requestedEffort: 'medium', effectiveEffort: 'high' },
    { requestedEffort: 'medium', effectiveEffortReason: 'model_without_reasoning' },
  ])(
    'audit.read projects route explanation without Provider identity, effort facts or raw extensions: %j',
    async (effortFacts) => {
      const f = await fixture();
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
        await f.close();
      }
    }
  );
  it('usage.read omits another user private Thread for a readonly member while preserving administrator eligibility', async () => {
    const f = await fixture();
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
    const thread = await f.store.createThread(f.workspaceId, 'Private', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
    });
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      applyScopedMigrations(db);
      const call = await startCapabilityCall({
        workspaceDb: db,
        workspaceId: f.workspaceId,
        threadId: thread.id,
        authorityActor: { kind: 'user', id: ensureLocalUser(f.coreDb) },
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses',
        redactionClass: 'metadata-only',
      });
      await recordUsage({
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
      await f.close();
    }
  });
  it('same-member retry keeps one call and deduplicates identical usage references', async () => {
    const f = await fixture();
    f.primary.setResponses([
      Object.assign(
        fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'rate_limit_exceeded' }),
        { code: 'rate_limit_exceeded' }
      ),
      fauxAssistantMessage('retry served'),
    ]);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const response = await settleFakedBackoff(f.post('responses'));
      expect(response.status).toBe(200);
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
      await f.close();
    }
  });
  it('refuses a reused running request before any Provider invocation and preserves its bytes', async () => {
    const f = await fixture();
    f.primary.setResponses([fauxAssistantMessage('must not run')]);
    const db = openWorkspaceDb(f.dataRoot, f.workspaceId);
    try {
      applyScopedMigrations(db);
      await startCapabilityCall({
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
      await f.close();
    }
  });
  it('identical backend usage collapses to one measurement cited by both retry entries', async () => {
    const f = await fixture();
    const dispatch = vi
      .spyOn(f.dispatcher, 'createResponses')
      .mockImplementation(async (_provider, request, context) => {
        await context?.onUsage?.({ total_tokens: 42 });
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
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const response = await settleFakedBackoff(f.post('responses'));
      expect(response.status).toBe(200);
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
      await f.close();
    }
  });
  it('a released stream without terminal evidence fails without replay and retains unknown lineage', async () => {
    const f = await fixture();
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
      await f.close();
    }
  });
  it('public calls without Workspace metadata keep Workspace history empty', async () => {
    const f = await fixture();
    f.primary.setResponses([fauxAssistantMessage('blind')]);
    try {
      await f.admitServerLedger();
      expect((await f.post('responses', false, false)).status).toBe(200);
      expect(f.read().calls).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

describe('slice 1d round 2 terminal frame closeout', () => {
  for (const failed of [true, false])
    it(`public released ${failed ? 'failed' : 'incomplete'} frame keeps its logical outcome`, async () => {
      const f = await fixture();
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
        await f.close();
      }
    });
});

it('skips a missing API key with auth_rejected lineage and only backup effort levels', async () => {
  const f = await fixture(true);
  const served = fauxAssistantMessage('backup served');
  served.usage = { ...served.usage, input: 7, output: 3, totalTokens: 10 };
  f.backup.setResponses([served]);
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
    // #447: retain the actual dispatch model beside the logical route and measured profile.
    for (const record of measured)
      expect(record).toMatchObject({
        modelId: 'tier',
        providerRef: 'b',
        providerModel: 'claude-sonnet-4-5',
      });
    // Each read opens a fresh handle; the identity survives ledger close and reopen.
    expect(f.read().usage).toEqual(usage);
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
    await f.close();
  }
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  releaseCommit();
  await shutdownControlStoreWorkerClient();
});
