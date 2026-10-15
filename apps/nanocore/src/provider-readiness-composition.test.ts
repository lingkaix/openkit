import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as setupResolver from './agents/setup-resolver.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import * as setupDiagnostics from './diagnostics/setup.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import type { resolveLogicalModelCatalog } from './llm/logical-models.js';
import { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import * as operationRoutes from './operation-json-routes.js';
import { ProviderRegistry } from './providers/registry.js';
import * as credentialOwners from './providers/vault-credential-resolver.js';
import type { PendingRequestRecord } from './runtime/pending-requests.js';
import * as productTurns from './runtime/product-turn-start.js';
import { getSchedulerPreparationClaims } from './runtime/scheduler-dispatch-loop.js';
import { WorkerGovernanceCapacityUnavailableError } from './runtime/worker-governance-backend.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { createVaultReference, revokeVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { listVaultUseRecords } from './vault/vault-use-records.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Observes the accepted Gateway owner references at each setup boundary. */
type LiveSetupDependencies = Parameters<typeof setupResolver.resolveAgentSetup>[1] & {
  providerCredentialConfigured?: Parameters<typeof resolveLogicalModelCatalog>[3];
  subscriptionAccounts?: Parameters<typeof resolveLogicalModelCatalog>[2];
};

const timestamp = '2026-10-15T00:00:00.000Z';

afterEach(() => vi.restoreAllMocks());

/** Composes real App owners over isolated metadata, with no Worker execution or Provider call. */
function fixture(supply: 'local' | 'api-key' | 'subscription' = 'local') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'provider-readiness-composition-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
  const vault = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server', 'vault'),
  });
  const accounts = new ProviderSubscriptionAccountManager({
    coreDb,
    vaultBackend: () => vault.backend(),
  });
  const warm = createTestAgentSetup({ agentId: 'agent_warm' }).manifest;
  const running = createTestAgentSetup({ agentId: 'agent_running' }).manifest;
  const preferred = createTestAgentSetup({ agentId: 'agent_default' }).manifest;
  const registry = new ProviderRegistry([
    {
      id: 'agent-openrouter',
      displayName: 'Fixture Provider',
      ...(supply === 'subscription'
        ? {
            kind: 'oauth' as const,
            vendor: 'openai-codex',
            extensions: { openkit: { subscriptionAccount: { accountSlotId: 'fixture' } } },
          }
        : supply === 'api-key'
          ? {
              kind: 'gateway' as const,
              vendor: 'openai',
              baseUrl: 'https://inference.example.invalid/v1',
              secretRef: 'vault://provider_presence_fixture',
            }
          : { kind: 'local' as const }),
      models: ['openai/gpt-5.2'],
    },
  ]);
  const gatewayConfig = createTestGatewayConfig();
  const manager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      agentManifests: [warm, running, preferred],
      gatewayConfig,
      providerRegistry: registry,
      openKitConfig: { defaults: { defaultAgentId: preferred.id } },
      workspaceConfigs: [
        {
          workspaceId: 'ws_demo',
          path: join(dataRoot, 'workspaces', 'ws_demo', 'config', 'workspace.jsonc'),
          config: WorkspaceConfigSchema.parse({
            schemaVersion: 1,
            workspace: { name: 'Demo Workspace', agents: [{ agentId: warm.id }] },
          }),
        },
      ],
    }),
  });
  store.createAgentSession({
    id: 'as_live_readiness',
    agentId: running.id,
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    status: 'ready',
    message: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const credentialFactory = vi.spyOn(credentialOwners, 'createProviderCredentialConfigured');
  const resolver = vi.spyOn(setupResolver, 'resolveAgentSetup');
  const diagnostics = vi.spyOn(setupDiagnostics, 'createSetupDiagnostics');
  const registration = vi.spyOn(operationRoutes, 'registerOperationJsonRoutes');
  const productAdmission = vi.spyOn(productTurns, 'startProductTurn');
  const executor = new SimulatedTurnExecutor({ coreDb });
  const prepare = vi
    .spyOn(executor, 'prepareAgentSessionForTurn')
    .mockRejectedValue(new WorkerGovernanceCapacityUnavailableError());
  const execute = vi.spyOn(executor, 'startTurn');
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    runtimeConfigManager: manager,
    providerSubscriptionAccountManager: accounts,
    vaultUnlockState: vault,
    providerCredentialResolver: () => null,
    turnExecutor: executor,
  });
  const configured = credentialFactory.mock.results.at(-1)!.value;
  expect(configured).toBeTypeOf('function');
  resolver.mockClear();
  return {
    accounts,
    app,
    configured,
    coreDb,
    dataRoot,
    diagnostics,
    manager,
    preferred,
    prepare,
    execute,
    productAdmission,
    registration,
    resolver,
    running,
    store,
    vault,
    warm,
    /** Disposes only this fixture's local state. */
    cleanup() {
      vault.lock();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Checks exact owner references, rather than a cached availability value or replacement owner. */
function expectLiveOwners(dependencies: unknown, f: ReturnType<typeof fixture>) {
  const live = dependencies as LiveSetupDependencies;
  expect(live.providerCredentialConfigured).toBe(f.configured);
  expect(live.subscriptionAccounts).toBe(f.accounts);
  return live;
}

/** Supplies a non-executable read-only captured request to the App's real evaluation callback. */
function capturedRequest(agentId: string): PendingRequestRecord {
  return {
    requestId: 'pr_readiness_composition',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    raisingTurnId: 'turn_readiness_composition',
    requestItemId: 'item_readiness_composition',
    kind: 'approval',
    requesterKind: 'worker',
    agentId,
    agentSessionId: 'as_live_readiness',
    responsibleUserId: 'user_local',
    state: 'pending',
    resolution: null,
    decidingActor: null,
    decidingActorContext: null,
    decidedAt: null,
    answerMap: null,
    ending: null,
    invalidatingEvent: null,
    endingActor: null,
    endedAt: null,
    serverId: null,
    catalogRevision: null,
    schemaSnapshotId: null,
    toolName: null,
    canonicalArgumentsJson: null,
    argumentsDigest: null,
    packageDigest: null,
    policyDecisionId: null,
    authorizationContext: null,
    governedIntent: null,
    questions: null,
    approvalKind: 'permission',
    title: null,
    description: null,
    claim: 'unclaimed',
    executionCallId: null,
    disposition: null,
    dispositionReason: null,
    heldResult: null,
    publicationTurnId: null,
    invalidationTurnId: null,
    delivery: 'undelivered',
    deliveryTurnId: null,
    deliveryCause: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('live Provider readiness composition', () => {
  it.each([
    ['public-turn', 'api-key'],
    ['public-turn', 'subscription'],
    ['direct-mode', 'api-key'],
    ['direct-mode', 'subscription'],
    ['remote-mcp', 'api-key'],
    ['remote-mcp', 'subscription'],
    ['pending-outcome', 'api-key'],
    ['pending-outcome', 'subscription'],
  ] as const)('refuses unavailable %s %s supply through real App admission before effects', async (entry, supply) => {
    const f = fixture(supply);
    try {
      if (supply === 'subscription') {
        f.vault.unlock({ masterKey: Buffer.alloc(32, 7) });
        await f.accounts.createAccount({
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'fixture',
        });
        expect(
          f.accounts.gatewayUnavailableReason({
            subscriptionProviderId: 'openai-codex',
            accountSlotId: 'fixture',
          })
        ).toBe('subscription_account_logged_out');
      }
      const frozen =
        entry === 'pending-outcome'
          ? f.store.createTurn(
              'ws_demo',
              'th_demo',
              'Receive pending request outcomes.',
              { kind: 'user', id: 'user_local' },
              f.manager.current().version,
              { agentId: f.preferred.id, status: 'pending', executorKind: 'worker' }
            )
          : undefined;
      const before = {
        turns: f.store.listThreadTurns('ws_demo', 'th_demo'),
        items: f.store.listThreadItems('ws_demo', 'th_demo'),
        receipts: f.store.listCommandRequests(),
      };
      const requestId = '00000000-0000-4000-8000-000000000932';
      const input = {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId,
        input: 'Use current supply.',
        agentId: f.preferred.id,
      };
      if (entry === 'public-turn') {
        const response = await f.app.request(
          ...operationRequest(
            'turn.start',
            { workspaceId: 'ws_demo', threadId: 'th_demo' },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
            }
          )
        );
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'agent_not_ready' });
      } else if (entry === 'direct-mode') {
        const start = f.registration.mock.calls.at(-1)![0].startModeWorkerTurn!;
        await expect(
          start({
            store: f.store,
            triggerActor: { kind: 'user', id: 'user_local' },
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            prompt: input.input,
            requestId,
            requestedAgentId: f.preferred.id,
            onTurnCreated: () => {
              throw new Error('Unexpected durable admission with unavailable supply.');
            },
          })
        ).rejects.toMatchObject({ code: 'agent_not_ready' });
      } else if (entry === 'remote-mcp') {
        const token = createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: 'user_local',
          scope: 'workspace',
          workspaceIds: ['ws_demo'],
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
        const response = await f.app.request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token.secret}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'call', arguments: { operation: 'turn.start', input } },
          }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const wire = await response.json();
        expect(wire.result.isError).toBe(true);
        expect(JSON.parse(wire.result.content[0].text)).toMatchObject({ code: 'agent_not_ready' });
      } else {
        const delivery =
          f.registration.mock.calls.at(-1)![0].pendingRequestServices!.workerDelivery!;
        const result = delivery.startTurn(f.store, frozen!.id);
        void result.catch(() => undefined);
        expectLiveOwners(f.productAdmission.mock.calls.at(-1)![0], f);
        await expect(result).rejects.toMatchObject({ code: 'agent_not_ready' });
      }
      expect(f.productAdmission).toHaveBeenCalledTimes(1);
      expectLiveOwners(f.productAdmission.mock.calls[0]![0], f);
      expectLiveOwners(f.resolver.mock.calls.at(-1)![1], f);
      expect(f.store.listThreadTurns('ws_demo', 'th_demo')).toEqual(before.turns);
      expect(f.store.listThreadItems('ws_demo', 'th_demo')).toEqual(before.items);
      expect(f.store.listCommandRequests()).toEqual(before.receipts);
      expect(f.coreDb.sqlite.prepare('SELECT * FROM scheduler_admission_entries').all()).toEqual(
        []
      );
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
    } finally {
      await setImmediate();
      await Promise.allSettled([...getSchedulerPreparationClaims(f.coreDb).values()]);
      f.cleanup();
    }
  });

  it('rechecks restored and revoked API-key supply on public Turns without reloading App', async () => {
    const f = fixture('api-key');
    try {
      const version = f.manager.current().version;
      for (const [index, phase] of ['missing', 'restored', 'revoked'].entries()) {
        if (phase === 'restored')
          createVaultReference(f.coreDb, {
            referenceId: 'provider_presence_fixture',
            ownerScope: 'server',
            displayName: 'Presence fixture',
            secretKind: 'provider-api-key',
            backendKind: 'encrypted-file',
          });
        if (phase === 'revoked')
          revokeVaultReference(f.coreDb, { referenceId: 'provider_presence_fixture' });
        const thread = f.store.createThread('ws_demo', `Live supply ${phase}`);
        const before = f.coreDb.sqlite.prepare('SELECT * FROM scheduler_admission_entries').all();
        const preparations = f.prepare.mock.calls.length;
        const response = await f.app.request(
          ...operationRequest(
            'turn.start',
            { workspaceId: 'ws_demo', threadId: thread.id },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                requestId: `00000000-0000-4000-8000-00000000094${index}`,
                input: 'Use current supply.',
                agentId: f.preferred.id,
              }),
            }
          )
        );
        expect(response.status, await response.clone().text()).toBe(
          phase === 'restored' ? 202 : 409
        );
        expectLiveOwners(f.productAdmission.mock.calls.at(-1)![0], f);
        if (phase === 'restored') {
          expect(f.store.listThreadTurns('ws_demo', thread.id)).toHaveLength(1);
          await setImmediate();
          await Promise.allSettled([...getSchedulerPreparationClaims(f.coreDb).values()]);
        } else {
          expect(await response.json()).toMatchObject({ code: 'agent_not_ready' });
          expect(f.store.listThreadTurns('ws_demo', thread.id)).toEqual([]);
          expect(
            f.coreDb.sqlite.prepare('SELECT * FROM scheduler_admission_entries').all()
          ).toEqual(before);
          expect(f.prepare).toHaveBeenCalledTimes(preparations);
        }
        expect(f.manager.current().version).toBe(version);
      }
      for (const [, dependencies] of f.resolver.mock.calls) expectLiveOwners(dependencies, f);
      expect(f.execute).not.toHaveBeenCalled();
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
    } finally {
      await setImmediate();
      await Promise.allSettled([...getSchedulerPreparationClaims(f.coreDb).values()]);
      f.cleanup();
    }
  });

  it('forwards current App owners through setup diagnostics without freezing availability', async () => {
    const f = fixture();
    const pair = { subscriptionProviderId: 'openai-codex', accountSlotId: 'fixture' } as const;
    try {
      for (const phase of ['missing', 'configured', 'revoked'] as const) {
        if (phase === 'configured')
          createVaultReference(f.coreDb, {
            referenceId: 'provider_presence_fixture',
            ownerScope: 'server',
            displayName: 'Presence fixture',
            secretKind: 'provider-api-key',
            backendKind: 'encrypted-file',
          });
        if (phase === 'revoked')
          revokeVaultReference(f.coreDb, { referenceId: 'provider_presence_fixture' });
        f.resolver.mockClear();
        const response = await f.app.request(...operationRequest('diagnostics.setup', {}));
        expect(response.status, await response.clone().text()).toBe(200);
        expect((await response.json()).agents).toHaveLength(3);
        expect(f.diagnostics).toHaveBeenCalled();
        expectLiveOwners(f.diagnostics.mock.calls.at(-1)![0], f);
        expect(f.resolver.mock.calls.map(([manifest]) => manifest.id)).toEqual([
          f.warm.id,
          f.running.id,
          f.preferred.id,
        ]);
        for (const [, dependencies] of f.resolver.mock.calls) {
          const live = expectLiveOwners(dependencies, f);
          expect(live.providerCredentialConfigured!('vault://provider_presence_fixture')).toBe(
            phase === 'configured'
          );
          expect(live.subscriptionAccounts!.gatewayUnavailableReason(pair)).toBe(
            phase === 'missing' ? 'subscription_vault_unavailable' : 'subscription_account_absent'
          );
        }
        if (phase === 'missing') f.vault.unlock({ masterKey: Buffer.alloc(32, 7) });
      }
      expect(f.resolver.mock.results.every((result) => result.type === 'return')).toBe(true);
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
      expect(f.store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it('forwards the same live owners to warm, running and default conversation targets', async () => {
    const f = fixture();
    try {
      const response = await f.app.request(
        ...operationRequest('conversation.targets', { workspaceId: 'ws_demo', threadId: 'th_demo' })
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await response.json()).targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'warm-worker' }),
          expect.objectContaining({ kind: 'running-worker' }),
          expect.objectContaining({ kind: 'new-task-worker' }),
        ])
      );
      // Candidate eligibility also resolves setup; retain the ordered target-specific observations.
      expect(f.resolver.mock.calls.slice(-3).map(([manifest]) => manifest.id)).toEqual([
        f.warm.id,
        f.running.id,
        f.preferred.id,
      ]);
      for (const [, dependencies] of f.resolver.mock.calls) expectLiveOwners(dependencies, f);
      expect(f.resolver.mock.results.every((result) => result.type === 'return')).toBe(true);
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
      expect(f.store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it('forwards the same live owners to the App captured-call setup evaluation', () => {
    const f = fixture();
    const workspaceDb = openWorkspaceDb(f.dataRoot, 'ws_demo');
    try {
      const services = f.registration.mock.calls.at(-1)![0].pendingRequestServices!;
      const facts = services.evaluateCapturedCall!(
        capturedRequest(f.running.id),
        workspaceDb.sqlite,
        { grants: [], failed: false }
      );
      expect(facts).toMatchObject({ toolInSupply: false, credentialsValid: false });
      expect(f.resolver).toHaveBeenCalledTimes(1);
      expect(f.resolver.mock.calls[0]![0].id).toBe(f.running.id);
      expectLiveOwners(f.resolver.mock.calls[0]![1], f);
      expect(f.resolver.mock.results[0]!.type).toBe('return');
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
      expect(f.store.listThreadTurns('ws_demo', 'th_demo')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      f.cleanup();
    }
  });
});
